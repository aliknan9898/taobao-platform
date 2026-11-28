# KINAN for Android

Flutter Android test app for KINAN Shop and Seller. The two sections load the existing KINAN web experiences in Android WebView. The defaults are `https://kinan.shop/shop` and `https://kinan.shop/seller`. External HTTPS and contact links open in their Android handlers. Use **Open in browser** when an authentication, upload, download or payment flow requires a full browser. The browser session is separate from the WebView session.

## Build

Use Flutter 3.41.9, JDK 17 or 21, and the Android SDK. From `mobile/`:

```sh
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

The generated APK is at `build/app/outputs/flutter-apk/app-release.apk`. The Android template's debug key is used for test distribution. For a Play release, configure a managed upload key and build an Android App Bundle. Keep its signing configuration and keys out of Git.

For an HTTPS staging host use `flutter build apk --release --dart-define=KINAN_ORIGIN=https://your-staging-host`. The origin must be the host serving both `/shop` and `/seller`.

## Device acceptance

Verify Shop and Seller sign-in, app resume, system back, localization, product details, import and AI preview, and tracking. Verify file selection, browser handoff and checkout on a staging account before distribution. Staff interfaces remain on the project website. See [Android readiness](../docs/ANDROID_READINESS.md).
