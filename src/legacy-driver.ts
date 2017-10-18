/**
 * Module for the legacy driver. Talks to pre-CMake Server versions of CMake.
 * Can also talk to newer versions of CMake via the command line.
 */ /** */

import {CMakeDriver} from './driver';
// import rollbar from './rollbar';
import {Kit} from './kit';
import {fs} from './pr';
import config from './config';
import * as util from './util';
import * as proc from './proc';
// import * as proc from './proc';
import * as logging from './logging';
import {VariantConfigurationOptions} from "./variant";
import {ConfigureArguments} from './variant';

const log = logging.createLogger('legacy-driver');

/**
 * The legacy driver.
 */
export class LegacyCMakeDriver extends CMakeDriver {
  private constructor() { super(); }

  private _needsReconfigure = true;
  get needsReconfigure() { return this._needsReconfigure; }

  async setKit(kit: Kit): Promise<void> {
    log.debug('Setting new kit', kit.name);
    this._needsReconfigure = true;
    const need_clean = this._kitChangeNeedsClean(kit);
    if (need_clean) {
      log.debug('Wiping build directory', this.binaryDir);
      await fs.rmdir(this.binaryDir);
    }
    this._setBaseKit(kit);
  }

  /**
   * The CMAKE_BUILD_TYPE to use
   */
  private _buildType: string = 'Debug';

  /**
   * The arguments to pass to CMake during a configuration
   */
  private _configArgs: ConfigureArguments[] = [];

  /**
   * Determine if we set BUILD_SHARED_LIBS to TRUE or FALSE
   */
  private _linkage: ('static' | 'shared') = 'static';

  async setVariantOptions(opts: VariantConfigurationOptions) {
    log.debug('Setting new variant', opts.description);
    this._buildType = opts.buildType || this._buildType;
    this._configArgs = opts.settings || this._configArgs;
    this._linkage = opts.linkage || this._linkage;
  }

  // Legacy disposal does nothing
  async asyncDispose() { log.debug('Dispose: Do nothing'); }

  async configure(outputConsumer?: proc.OutputConsumer): Promise<number> {
    if (!await this._beforeConfigure()) {
      log.debug('Pre-configure steps aborted configure');
      // Pre-configure steps failed. Bad...
      return -1;
    }
    log.debug('Proceeding with configuration');

    // Build up the CMake arguments
    const args: string[] = [];
    if (!await fs.exists(this.cachePath)) {
      // No cache! We are free to change the generator!
      const generator = 'Ninja';  // TODO: Find generators!
      log.debug('Using', generator, 'CMake generator');
      args.push('-G' + generator);
      // TODO: Platform and toolset selection
    }

    for (const setting of this._configArgs) {
      const cmake_value = util.cmakeify(setting.value);
      args.push(`${setting.key}:${cmake_value.type}=${cmake_value.value}`);
    }

    args.push(`-DCMAKE_BUILD_TYPE:STRING=${this._buildType}`);

    // TODO: Make sure we are respecting all variant options

    // TODO: Read options from settings.json

    console.assert(!!this._kit);
    if (!this._kit) {
      throw new Error('No kit is set!');
    }
    switch (this._kit.type) {
    case 'compilerKit': {
      log.debug('Using compilerKit', this._kit.name, 'for usage');
      args.push(...util.objectPairs(this._kit.compilers)
                    .map(([ lang, comp ]) => `-DCMAKE_${lang}_COMPILER:FILEPATH=${comp}`));
    }
    }

    const cmake_settings = this._cmakeFlags();
    args.push(...cmake_settings);
    args.push('-H' + util.normalizePath(this.sourceDir));
    const bindir = util.normalizePath(this.binaryDir);
    args.push('-B' + bindir);
    log.debug('Invoking CMake', config.cmakePath, 'with arguments', JSON.stringify(args));
    const res = await proc.execute(config.cmakePath, args, outputConsumer).result;
    log.trace(res.stderr);
    log.trace(res.stdout);
    this._needsReconfigure = false;
    return res.retc;
  }

  async build(target: string, consumer?: proc.OutputConsumer): Promise<proc.Subprocess | null> {
    const ok = await this._beforeConfigure();
    if (!ok) {
      return null;
    }
    const gen = await this.generatorName;
    const generator_args = (() => {
      if (!gen)
        return [];
      else if (/(Unix|MinGW) Makefiles|Ninja/.test(gen) && target !== 'clean')
        return [ '-j', config.numJobs.toString() ];
      else if (gen.includes('Visual Studio'))
        return [
          '/m',
          '/property:GenerateFullPaths=true',
        ];  // TODO: Older VS doesn't support these flags
      else
        return [];
    })();
    const args =
        [ '--build', this.binaryDir, '--config', this._buildType, '--' ].concat(generator_args);
    return proc.execute(config.cmakePath, args, consumer);
  }

  static async create(): Promise<LegacyCMakeDriver> {
    log.debug('Creating instance of LegacyCMakeDriver');
    const inst = new LegacyCMakeDriver();
    await inst._init();
    return inst;
  }
}
