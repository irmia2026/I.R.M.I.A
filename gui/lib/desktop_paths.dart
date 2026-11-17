import 'dart:io';

String? _absolute(Map<String, String> env, String name) {
  final value = env[name]?.trim();
  return value != null && value.startsWith('/') ? value : null;
}

String? linuxRuntimeDirectory(Map<String, String> env) {
  final root = _absolute(env, 'XDG_RUNTIME_DIR');
  return root == null ? null : '$root/irmia';
}

String? _linuxDirectory(Map<String, String> env, String variable, String homeSuffix) {
  final explicit = _absolute(env, variable);
  if (explicit != null) return '$explicit/irmia';
  final home = _absolute(env, 'HOME');
  return home == null ? null : '$home/$homeSuffix/irmia';
}

String? linuxStateDirectory(Map<String, String> env) => _linuxDirectory(env, 'XDG_STATE_HOME', '.local/state');
String? linuxConfigDirectory(Map<String, String> env) => _linuxDirectory(env, 'XDG_CONFIG_HOME', '.config');

// Without a home directory, keep temporary GUI state private and scoped to this process.
late final String _temporaryState = Directory.systemTemp.createTempSync('irmia-gui-').path;

String guiStateDirectory(Map<String, String> env) {
  if (Platform.isLinux) return linuxStateDirectory(env) ?? _temporaryState;
  final base = env['APPDATA'] ?? Directory.systemTemp.path;
  return '$base${Platform.pathSeparator}Irmia';
}

String guiConfigDirectory(Map<String, String> env) =>
    Platform.isLinux ? (linuxConfigDirectory(env) ?? _temporaryState) : guiStateDirectory(env);
