require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "jose-native-sse"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # React Native 0.86 (Expo SDK 57) requires iOS 15.1 as the deployment target.
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => "https://github.com/EduHo/jose-native-sse.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.exclude_files = "ios/build"

  # New Architecture (TurboModules) codegen
  install_modules_dependencies(s)
end
