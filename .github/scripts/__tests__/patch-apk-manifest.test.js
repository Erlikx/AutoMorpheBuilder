'use strict';

const { parseArgs } = require('../patch-apk-manifest');

describe('patch-apk-manifest CLI validation', () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('rejects versionCode values above Android signed 32-bit max', () => {
    expect(() => parseArgs([
      'node',
      'patch-apk-manifest.js',
      'in.apk',
      'out.apk',
      '--version-code',
      '2147483648',
    ])).toThrow('process.exit:1');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Android signed 32-bit integer'));
  });

  test('accepts the Android signed 32-bit max versionCode', () => {
    expect(parseArgs([
      'node',
      'patch-apk-manifest.js',
      'in.apk',
      'out.apk',
      '--version-code',
      '2147483647',
    ])).toMatchObject({
      input: 'in.apk',
      output: 'out.apk',
      versionCode: 2147483647,
    });

    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('Android signed 32-bit integer'));
  });
});
