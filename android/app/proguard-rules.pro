# ProGuard rules for Rent Ledger
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.rentledger.tenant.** { *; }
-dontwarn android.webkit.**

