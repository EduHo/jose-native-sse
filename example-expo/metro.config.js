const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);

// Watch the parent so edits to src/ hot-reload without reinstalling.
config.watchFolders = [root];

// 1. Block the parent's react / react-native devDependencies so they are never
//    bundled — a version drift from the native binary would be fatal, and even
//    matching versions show up as duplicate native modules to expo-doctor.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [
  new RegExp(`^${esc(path.join(root, 'node_modules', 'react-native'))}[\\/].*$`),
  new RegExp(`^${esc(path.join(root, 'node_modules', 'react'))}[\\/].*$`),
];

// 2. Redirect ALL react / react-native imports (including those coming from
//    ../src/*.ts while being watched) to example-expo's own versions.
config.resolver.extraNodeModules = {
  'react-native': path.resolve(__dirname, 'node_modules/react-native'),
  'react':        path.resolve(__dirname, 'node_modules/react'),
};

module.exports = config;
