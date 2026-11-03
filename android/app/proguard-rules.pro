# The page calls these through the WebView bridge (window.Android).
-keepclassmembers class com.fantasytv.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
