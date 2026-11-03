import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:irmia_gui/instances.dart';

void main() {
  test('默认实例用安装根 config；普通实例用 <dataDir>/config.json', () {
    final root = Directory.systemTemp.createTempSync('irmia-gui-instance-config-');
    addTearDown(() => root.deleteSync(recursive: true));
    final sep = Platform.pathSeparator;
    final installRoot = root.path;
    final entry = '$installRoot${sep}dist${sep}main.js';
    Directory('$installRoot${sep}dist').createSync(recursive: true);
    File('$installRoot${sep}config.json').writeAsStringSync(jsonEncode({'dataDir': 'data'}));

    final defaultDataDir = '$installRoot${sep}data';
    expect(
      instanceConfigPathFor(entry: entry, dataDir: defaultDataDir),
      '$installRoot${sep}config.json',
      reason: '默认实例继续用安装根配置',
    );

    final instanceDir = '$installRoot${sep}instances${sep}astra';
    expect(
      instanceConfigPathFor(entry: entry, dataDir: instanceDir),
      '$instanceDir${sep}config.json',
      reason: '非默认实例必须用自己的配置',
    );

    final args = backendNodeArgs(entry: entry, dataDir: instanceDir, port: 7789);
    final at = args.indexOf('--config');
    expect(at, greaterThanOrEqualTo(0));
    expect(args[at + 1], '$instanceDir${sep}config.json');
    expect(args, containsAllInOrder(<String>['--data-dir', instanceDir, '--port', '7789']));
  });
}
