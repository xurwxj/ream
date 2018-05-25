const path = require('path')
const Event = require('events')
const fs = require('fs-extra')
const Config = require('webpack-chain')
const express = require('express')
const chalk = require('chalk')
const merge = require('lodash.merge')
const { createBundleRenderer } = require('vue-server-renderer')
const UseConfig = require('use-config')
const basePlugin = require('./plugins/base')
const logger = require('./logger')
const serveStatic = require('./utils/serveStatic')
const renderTemplate = require('./utils/renderTemplate')
const emoji = require('./emoji')
const inspect = require('./utils/inspect')

const runWebpack = compiler => {
  return new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) return reject(err)
      resolve(stats)
    })
  })
}

class Ream extends Event {
  constructor(options = {}) {
    super()
    // Init logger options
    logger.setOptions(options)

    if (!process.env.NODE_ENV) {
      process.env.NODE_ENV = options.dev ? 'development' : 'production'
    }

    // Load ream config
    const useConfig = new UseConfig({
      files: ['{name}.config.js', 'package.json'],
      name: 'ream'
    })
    const { path: configPath, config } = useConfig.loadSync()
    if (configPath) {
      logger.debug('ream config', configPath)
    }

    // Init options
    this.options = merge(
      {
        entry: 'index.js',
        plugins: [],
        server: {
          host: process.env.HOST || '0.0.0.0',
          port: process.env.PORT || 4000
        },
        generate: {
          routes: ['/']
        }
      },
      config,
      options
    )
    this.options.entry = path.resolve(this.options.entry)
    this.options.rootPublicFiles = [
      ...new Set(
        ['favicon.ico', 'CNAME', '.nojekyll', '.well-known'].concat(
          this.options.rootPublicFiles || []
        )
      )
    ]
    logger.debug('ream options', inspect(this.options))

    this.hooks = require('./hooks')
    this.configureServerFns = new Set()
    this.enhanceAppFiles = new Set()
    this.serverConfig = new Config()
    this.clientConfig = new Config()
    this.chainWebpackFns = []
    this.loadPlugins()
  }

  chainWebpack(fn) {
    this.chainWebpackFns.push(fn)
  }

  addGenerateRoutes(routes) {
    this.options.generate.routes = this.options.generate.routes.concat(routes)
    return this
  }

  runChainWebpackFns() {
    for (const fn of this.chainWebpackFns) {
      fn(this.serverConfig, {
        type: 'server',
        isServer: true,
        isClient: false,
        dev: this.options.dev
      })
      fn(this.clientConfig, {
        type: 'client',
        isServer: false,
        isClient: true,
        dev: this.options.dev
      })
    }
  }

  hasPlugin(name) {
    return this.plugins && this.plugins.find(plugin => plugin.name === name)
  }

  loadPlugins() {
    this.plugins = [basePlugin, require('./plugins/pwa')]
      .concat(this.options.plugins)
      .filter(Boolean)

    this.plugins.forEach(plugin => plugin.apply(this))
  }

  createCompilers() {
    if (this.options.debugWebpack) {
      console.log('server config', chalk.dim(this.serverConfig.toString()))
      console.log('client config', chalk.dim(this.clientConfig.toString()))
    }

    const serverConfig = this.serverConfig.toConfig()
    const serverCompiler = require('webpack')(serverConfig)

    const clientConfig = this.clientConfig.toConfig()
    const clientCompiler = require('webpack')(clientConfig)

    return {
      serverCompiler,
      clientCompiler
    }
  }

  async build() {
    await fs.remove(this.resolveDist())
    await this.prepareWebpack()
    this.runChainWebpackFns()
    const { serverCompiler, clientCompiler } = this.createCompilers()
    await Promise.all([runWebpack(serverCompiler), runWebpack(clientCompiler)])
    if (!this.isGenerating) {
      await this.hooks.run('onFinished', 'build')
    }
  }

  async generate(opts) {
    this.isGenerating = true
    await this.build()
    await this.generateOnly(opts)
    await this.hooks.run('onFinished', 'generate')
  }

  async generateOnly({ routes } = this.options.generate) {
    routes = [...new Set(routes)]
    // Not an actually server
    // Don't emit `server-ready` event
    this.prepareProduction({ serverType: 'generate' })
    // Copy assets to `generated`
    await Promise.all([
      fs.copy(this.resolveDist('client'), this.resolveDist('generated/_ream')),
      fs
        .pathExists(path.resolve('public'))
        .then(
          exists =>
            exists &&
            fs.copy(
              path.resolve('public'),
              this.resolveDist('generated/public')
            )
        )
    ])
    // Hoist rootPublicFiles
    await Promise.all(
      this.options.rootPublicFiles.map(async file => {
        const from = path.resolve('public', file)
        const exists = await fs.pathExists(from)
        return exists && fs.copy(from, this.resolveDist('generated', file))
      })
    )
    // Remove unnecessary files
    await fs.remove(this.resolveDist('generated/_ream/client-manifest.json'))

    await Promise.all(
      routes.map(async route => {
        // Fake req
        const context = { req: { url: route } }
        const html = await this.renderer.renderToString(context)
        const { start, end } = await renderTemplate(context)
        const targetPath = this.resolveDist(
          `generated/${route.replace(/\/?$/, '/index.html')}`
        )

        logger.status(emoji.progress, `generating ${route}`)

        await fs.ensureDir(path.dirname(targetPath))
        await fs.writeFile(targetPath, start + html + end, 'utf8')
      })
    )

    logger.status(
      emoji.success,
      chalk.green(
        `Check out ${path.relative(
          process.cwd(),
          this.resolveDist('generated')
        )}`
      )
    )
  }

  configureServer(fn) {
    this.configureServerFns.add(fn)
  }

  async prepareFiles() {
    const createAppFile = this.resolveDist('create-app.js')
    await fs.ensureDir(path.dirname(createAppFile))
    await fs.writeFile(
      createAppFile,
      require('../app/create-app-template')(this)
    )
  }

  async getServer() {
    const notFound = (req, res) => () => {
      res.statusCode = 404
      res.end('not found')
    }

    const server = express()

    for (const fn of this.configureServerFns) {
      fn(server)
    }

    if (this.options.dev) {
      await this.prepareWebpack()
      this.runChainWebpackFns()
      require('./utils/setupWebpackMiddlewares')(this)(server)
    } else {
      this.prepareProduction({ serverType: 'production' })
      server.get('/_ream/*', (req, res) => {
        req.url = req.url.replace(/^\/_ream/, '')
        serveStatic(
          this.resolveDist('client'),
          typeof req.shouldCache === 'boolean' ? req.shouldCache : true // Cache
        )(req, res, notFound(req, res))
      })
    }

    server.get('/public/*', (req, res) => {
      serveStatic(process.cwd(), !this.options.dev)(
        req,
        res,
        notFound(req, res)
      )
    })

    for (const rootPublicFile of this.options.rootPublicFiles) {
      server.get(`/${rootPublicFile}`, (req, res) => {
        serveStatic(path.resolve('public'), !this.options.dev)(
          req,
          res,
          notFound(req, res)
        )
      })
    }

    server.get('*', async (req, res) => {
      if (!this.renderer) {
        return res.end('Please wait for compilation...')
      }

      if (req.url.startsWith('/_ream/')) {
        res.status(404)
        return res.end('404')
      }

      const handleError = err => {
        if (err.code === 404) return notFound(req, res)()

        if (process.env.NODE_ENV === 'production') {
          res.end('server error')
        } else {
          res.end(err.stack)
        }

        if (err.name === 'ReamError') {
          console.log(err.message)
        } else {
          console.log(err.stack)
        }
      }

      const context = { req }

      let html
      try {
        html = await this.renderer.renderToString(context)
      } catch (err) {
        return handleError(err)
      }

      res.setHeader('content-type', 'text/html')
      const { start, end } = await renderTemplate(context)
      res.end(start + html + end)
    })

    return server
  }

  async getRequestHandler() {
    const server = await this.getServer()
    return (req, res) => server(req, res)
  }

  async start() {
    const server = await this.getServer()
    return server.listen(this.options.server.port, this.options.server.host)
  }

  async prepareWebpack() {
    const postcssrc = require('postcss-load-config')

    const handleError = err => {
      if (err.message.indexOf('No PostCSS Config found') === -1) {
        throw err
      }
      // Return empty options for PostCSS
      return {}
    }

    const postcssConfig = await postcssrc({}, process.cwd(), {
      argv: false
    }).catch(handleError)

    if (postcssConfig.file) {
      logger.debug('postcss config', postcssConfig.file)
      this.options.postcss = postcssConfig.options
      logger.debug('postcss options', this.options.postcss)
    }

    await this.prepareFiles()
  }

  prepareProduction({ serverType } = {}) {
    const serverBundle = JSON.parse(
      fs.readFileSync(this.resolveDist('server/server-bundle.json'), 'utf8')
    )
    const clientManifest = JSON.parse(
      fs.readFileSync(this.resolveDist('client/client-manifest.json'), 'utf8')
    )

    this.createRenderer({
      serverBundle,
      clientManifest,
      serverType
    })
  }

  // Async readBundleMeta() {
  //   const [serverBundle, clientManifest, template] = await Promise.all([
  //     fs
  //       .readFile(this.resolveDist('server/server-bundle.json'), 'utf8')
  //       .then(JSON.parse),
  //     fs
  //       .readFile(this.resolveDist('client/client-manifest.json'), 'utf8')
  //       .then(JSON.parse),
  //     fs.readFile(this.resolveDist('client/index.html'), 'utf8')
  //   ])

  //   return {
  //     serverBundle,
  //     clientManifest,
  //     template
  //   }
  // }

  createRenderer({ serverBundle, clientManifest, serverType }) {
    this.renderer = createBundleRenderer(serverBundle, {
      runInNewContext: false,
      clientManifest
    })
    this.emit('renderer-ready', serverType)
  }

  resolveDist(...args) {
    return path.resolve('.ream', ...args)
  }
}

function ream(opts) {
  return new Ream(opts)
}
module.exports = ream
module.exports.Ream = Ream
