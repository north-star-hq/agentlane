const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

// expo-dev-menu reads these from the application's meta-data on Android, as it reads the same keys from Info.plist on iOS.
module.exports = function withAndroidDevMenu(config, values) {
  return withAndroidManifest(config, mod => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    for (const [key, value] of Object.entries(values)) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, key, String(value));
    }
    return mod;
  });
};
