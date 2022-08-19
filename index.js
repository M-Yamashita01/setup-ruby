const os = require('os')
const fs = require('fs')
const path = require('path')
const core = require('@actions/core')
const exec = require('@actions/exec')
const common = require('./common')
const rubygems = require('./rubygems')
const bundler = require('./bundler')

const windows = common.windows

const inputDefaults = {
  'ruby-version': 'default',
  'ruby-version-file': 'Gemfile.lock',
  'rubygems': 'default',
  'bundler': 'Gemfile.lock',
  'bundler-cache': 'false',
  'working-directory': '.',
  'cache-version': bundler.DEFAULT_CACHE_VERSION,
}

// entry point when this action is run on its own
export async function run() {
  try {
    await setupRuby()
  } catch (error) {
    core.setFailed(error.stack)
  }
}

// entry point when this action is run from other actions
export async function setupRuby(options = {}) {
  const inputs = { ...options }
  for (const key in inputDefaults) {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) {
      inputs[key] = core.getInput(key) || inputDefaults[key]
    }
  }

  process.chdir(inputs['working-directory'])

  const platform = common.getVirtualEnvironmentName()
  // const [engine, parsedVersion] = parseRubyEngineAndVersion(inputs['ruby-version'])
  const [engine, parsedVersion] = parseRubyEngineAndVersion(inputs)

  let installer
  if (platform.startsWith('windows-') && engine === 'ruby') {
    installer = require('./windows')
  } else {
    installer = require('./ruby-builder')
  }

  const engineVersions = installer.getAvailableVersions(platform, engine)
  const version = validateRubyEngineAndVersion(platform, engineVersions, engine, parsedVersion)

  createGemRC(engine, version)
  envPreInstall()

  // JRuby can use compiled extension code, so make sure gcc exists.
  // As of Jan-2022, JRuby compiles against msvcrt.
  if (platform.startsWith('windows') && (engine === 'jruby') && 
    !fs.existsSync('C:\\msys64\\mingw64\\bin\\gcc.exe')) {
    await require('./windows').installJRubyTools()
  }

  const rubyPrefix = await installer.install(platform, engine, version)

  await common.measure('Print Ruby version', async () =>
    await exec.exec('ruby', ['--version']))

  const rubygemsInputSet = inputs['rubygems'] !== 'default'
  if (rubygemsInputSet) {
    await common.measure('Updating RubyGems', async () =>
      rubygems.rubygemsUpdate(inputs['rubygems'], rubyPrefix))
  }

  // When setup-ruby is used by other actions, this allows code in them to run
  // before 'bundle install'.  Installed dependencies may require additional
  // libraries & headers, build tools, etc.
  if (inputs['afterSetupPathHook'] instanceof Function) {
    await inputs['afterSetupPathHook']({ platform, rubyPrefix, engine, version })
  }

  const [gemfile, lockFile] = bundler.detectGemfiles()
  let bundlerVersion = 'unknown'

  if (inputs['bundler'] !== 'none') {
    bundlerVersion = await common.measure('Installing Bundler', async () =>
      bundler.installBundler(inputs['bundler'], rubygemsInputSet, lockFile, platform, rubyPrefix, engine, version))
  }

  if (inputs['bundler-cache'] === 'true') {
    await common.measure('bundle install', async () =>
      bundler.bundleInstall(gemfile, lockFile, platform, engine, version, bundlerVersion, inputs['cache-version']))
  }

  core.setOutput('ruby-prefix', rubyPrefix)
}

function parseRubyEngineAndVersion(inputs) {
  let rubyVersion = inputs['ruby-version']
  let versionFilePath = inputs['ruby-version-file']
  if (rubyVersion !== 'default' && versionFilePath) {
    core.warning('The ruby-version input is not `default` and ruby-version-file input is specified, only ruby-version will be used')
  }

  let engine, version

  console.log("inputs: " + JSON.stringify(inputs, null, 2))
  console.log("rubyVersion: " + rubyVersion)
  console.log("versionFilePath: " + versionFilePath)

  if (rubyVersion === 'default' && versionFilePath) {
    const contents = fs.readFileSync(versionFilePath, 'utf8')
    const lines = contents.split(/\r?\n/)
    const rubyVersionLine = lines.findIndex(line => /^RUBY VERSION$/.test(line.trim()))
    if (rubyVersionLine !== -1) {
      const nextLine = lines[rubyVersionLine + 1]
      if (nextLine && /^\d+/.test(nextLine.trim())) {
        engine = "ruby"
        const trimmedNextLine = nextLine.trim()
        version = trimmedNextLine.match(/\d.\d.\d/)
      }else {
        throw new Error('no ruby version in Gemfile.lock.')
      }
    }
  } else {
    if (rubyVersion === 'default') {
      if (fs.existsSync('.ruby-version')) {
        rubyVersion = '.ruby-version'
      } else if (fs.existsSync('.tool-versions')) {
        rubyVersion = '.tool-versions'
      } else {
        throw new Error('input ruby-version needs to be specified if no .ruby-version or .tool-versions file exists')
      }
    }

    if (rubyVersion === '.ruby-version') { // Read from .ruby-version
      rubyVersion = fs.readFileSync('.ruby-version', 'utf8').trim()
      console.log(`Using ${rubyVersion} as input from file .ruby-version`)
    } else if (rubyVersion === '.tool-versions') { // Read from .tool-versions
      const toolVersions = fs.readFileSync('.tool-versions', 'utf8').trim()
      const rubyLine = toolVersions.split(/\r?\n/).filter(e => /^ruby\s/.test(e))[0]
      rubyVersion = rubyLine.match(/^ruby\s+(.+)$/)[1]
      console.log(`Using ${rubyVersion} as input from file .tool-versions`)
    }

    if (/^(\d+)/.test(rubyVersion) || common.isHeadVersion(rubyVersion)) { // X.Y.Z => ruby-X.Y.Z
      engine = 'ruby'
      version = rubyVersion
    } else if (!rubyVersion.includes('-')) { // myruby -> myruby-stableVersion
      engine = rubyVersion
      version = '' // Let the logic in validateRubyEngineAndVersion() find the version
    } else { // engine-X.Y.Z
      [engine, version] = common.partition(rubyVersion, '-')
    }
  }

  return [engine, version]
}

function validateRubyEngineAndVersion(platform, engineVersions, engine, parsedVersion) {
  if (!engineVersions) {
    throw new Error(`Unknown engine ${engine} on ${platform}`)
  }

  let version = parsedVersion
  if (!engineVersions.includes(parsedVersion)) {
    const latestToFirstVersion = engineVersions.slice().reverse()
    // Try to match stable versions first, so an empty version (engine-only) matches the latest stable version
    let found = latestToFirstVersion.find(v => common.isStableVersion(v) && v.startsWith(parsedVersion))
    if (!found) {
      // Exclude head versions, they must be exact matches
      found = latestToFirstVersion.find(v => !common.isHeadVersion(v) && v.startsWith(parsedVersion))
    }

    if (found) {
      version = found
    } else {
      throw new Error(`Unknown version ${parsedVersion} for ${engine} on ${platform}
        available versions for ${engine} on ${platform}: ${engineVersions.join(', ')}
        Make sure you use the latest version of the action with - uses: ruby/setup-ruby@v1`)
    }
  }

  return version
}

function createGemRC(engine, version) {
  const gemrc = path.join(os.homedir(), '.gemrc')
  if (!fs.existsSync(gemrc)) {
    if (engine === 'ruby' && common.floatVersion(version) < 2.0) {
      fs.writeFileSync(gemrc, `install: --no-rdoc --no-ri${os.EOL}update: --no-rdoc --no-ri${os.EOL}`)
    } else {
      fs.writeFileSync(gemrc, `gem: --no-document${os.EOL}`)
    }
  }
}

// sets up ENV variables
// currently only used on Windows runners
function envPreInstall() {
  const ENV = process.env
  if (windows) {
    // puts normal Ruby temp folder on SSD
    core.exportVariable('TMPDIR', ENV['RUNNER_TEMP'])
    // bash - sets home to match native windows, normally C:\Users\<user name>
    core.exportVariable('HOME', ENV['HOMEDRIVE'] + ENV['HOMEPATH'])
    // bash - needed to maintain Path from Windows
    core.exportVariable('MSYS2_PATH_TYPE', 'inherit')
  }
}

if (__filename.endsWith('index.js')) { run() }
