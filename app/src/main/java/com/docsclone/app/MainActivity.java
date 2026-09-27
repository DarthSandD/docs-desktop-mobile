package com.docsclone.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_PICK = 1001;
    private static final int FILE_CREATE = 1002;
    private String pendingExportName = "document.txt";
    private String pendingExportMime = "text/plain";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("docsclone", MODE_PRIVATE);

        // Edge-to-edge-ish, keep status bar colored
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);          // we do our own pinch-zoom in JS for smoothness
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.setBackgroundColor(0xFFF1F3F4);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                if (u.startsWith("http://") || u.startsWith("https://")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
                    } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                filePathCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Open document"), FILE_PICK);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidHost");
        web.loadUrl("file:///android_asset/editor/index.html");

        setContentView(web);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__onAndroidBack && window.__onAndroidBack()", value -> {
            if (value == null || !value.contains("true")) {
                // let JS decide; if it did not consume, exit
            }
        });
        // Give JS a tick; if it didn't navigate, finish
        web.postDelayed(() -> {
            // no-op: JS handles via exitApp if needed
        }, 50);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_PICK) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{ data.getData() };
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(results);
                    filePathCallback = null;
                }
            } else {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
            }
            return;
        }
        if (requestCode == FILE_CREATE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                String content = prefs.getString("__pending_export__", "");
                String enc = prefs.getString("__pending_export_enc__", "utf8");
                try {
                    byte[] bytes;
                    if ("base64".equals(enc)) {
                        bytes = android.util.Base64.decode(content, android.util.Base64.DEFAULT);
                    } else {
                        bytes = content.getBytes(StandardCharsets.UTF_8);
                    }
                    OutputStream os = getContentResolver().openOutputStream(data.getData());
                    if (os != null) {
                        os.write(bytes);
                        os.flush();
                        os.close();
                        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
                    }
                } catch (Exception e) {
                    Toast.makeText(this, "Save failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
                prefs.edit().remove("__pending_export__").apply();
                prefs.edit().remove("__pending_export_enc__").apply();
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** JS <-> native bridge */
    public class Bridge {

        @JavascriptInterface
        public String getStore(String key) {
            return prefs.getString(key, null);
        }

        @JavascriptInterface
        public void setStore(String key, String value) {
            prefs.edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public void removeStore(String key) {
            prefs.edit().remove(key).apply();
        }

        @JavascriptInterface
        public void haptic(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(ms);
                }
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finish);
        }

        @JavascriptInterface
        public void openFilePicker() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(Intent.createChooser(i, "Open document"), FILE_PICK);
            });
        }

        @JavascriptInterface
        public void exportFile(String filename, String mime, String content) {
            pendingExportName = filename;
            pendingExportMime = mime;
            prefs.edit().putString("__pending_export__", content).apply();
            prefs.edit().putString("__pending_export_enc__", "utf8").apply();
            runOnUiThread(() -> launchCreate(filename, mime));
        }

        /** Export binary payload (DOCX etc.) supplied as base64. */
        @JavascriptInterface
        public void exportFileBinary(String filename, String mime, String base64) {
            pendingExportName = filename;
            pendingExportMime = mime;
            prefs.edit().putString("__pending_export__", base64).apply();
            prefs.edit().putString("__pending_export_enc__", "base64").apply();
            runOnUiThread(() -> launchCreate(filename, mime));
        }

        private void launchCreate(String filename, String mime) {
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime);
            i.putExtra(Intent.EXTRA_TITLE, filename);
            startActivityForResult(i, FILE_CREATE);
        }
    }
}
