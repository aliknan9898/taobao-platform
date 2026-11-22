#!/usr/bin/env bash
# Generates the Android/iOS project files with the local Flutter SDK, keeping the files committed in
# android/ (Stripe-ready MainActivity, AppCompat themes, manifests, ProGuard rules). `flutter create`
# never overwrites existing files. Run once after cloning, from apps/shop-mobile.
set -euo pipefail
cd "$(dirname "$0")/.."
flutter --version
flutter create --platforms=android,ios --org shop.kinan --project-name kinan_shop --no-pub .
flutter pub get
# iOS: Stripe needs iOS 13+. The Podfile appears after the first iOS build/pod install.
if [ -f ios/Podfile ]; then sed -i.bak "s/^# platform :ios, .*/platform :ios, '13.0'/" ios/Podfile && rm -f ios/Podfile.bak; fi
# iOS: allow plain HTTP to local addresses only (local staging server); remote hosts stay HTTPS-only.
PB=/usr/libexec/PlistBuddy
if [ -x "$PB" ] && [ -f ios/Runner/Info.plist ]; then
  "$PB" -c "Add :NSAppTransportSecurity dict" ios/Runner/Info.plist 2>/dev/null || true
  "$PB" -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" ios/Runner/Info.plist 2>/dev/null || true
fi
echo "Platforms ready. Next: flutter analyze && flutter test"
