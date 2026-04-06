const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');

/**
 * Metro config for the example app.
 * Watches the parent library source so changes to src/ are reflected
 * immediately without a publish/install step.
 */
const config = {
  watchFolders: [root],
  resolver: {
    extraNodeModules: {
      'jose-native-sse': path.resolve(root, 'src'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
