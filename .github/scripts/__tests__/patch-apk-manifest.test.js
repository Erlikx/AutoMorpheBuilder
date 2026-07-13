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

  test('rejects versionCode values above uint32 max', () => {
    expect(() => parseArgs([
      'node',
      'patch-apk-manifest.js',
      'in.apk',
      'out.apk',
      '--version-code',
      '4294967296',
    ])).toThrow('process.exit:1');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('32-bit integer'));
  });

  test('accepts values up to uint32 max', () => {
    expect(parseArgs([
      'node',
      'patch-apk-manifest.js',
      'in.apk',
      'out.apk',
      '--version-code',
      '4294967295',
    ])).toMatchObject({
      input: 'in.apk',
      output: 'out.apk',
      versionCode: 4294967295,
    });

    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('32-bit integer'));
  });
});
