package com.suitebookings.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    static final String DEFAULT_URL = BuildConfig.DEFAULT_URL;
    static final String PREFS = "suite";
    static final String KEY_URL = "server_url";

    private WebView web;
    private LinearLayout errorView;
    private TextView errorText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#4f46e5"));

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        errorView = buildErrorView();
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " SuiteBookingsApp/1");
        web.addJavascriptInterface(new Bridge(), "AndroidApp");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                Uri base = Uri.parse(serverUrl());
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ((scheme.equals("http") || scheme.equals("https")) && base.getHost() != null && base.getHost().equals(uri.getHost())) {
                    return false;
                }
                openExternal(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError("Can't reach the booking server.\n\n" + serverUrl() + "\n\nCheck your internet connection, or ask the owner for the correct server address.");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!url.startsWith("data:")) errorView.setVisibility(View.GONE);
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else load();
    }

    String serverUrl() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, DEFAULT_URL);
    }

    void load() {
        errorView.setVisibility(View.GONE);
        web.loadUrl(serverUrl());
    }

    void showError(String msg) {
        errorText.setText(msg);
        errorView.setVisibility(View.VISIBLE);
    }

    LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#f4f5f9"));
        int pad = dp(28);
        box.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText("Akari Suite Booking System");
        title.setTextSize(24);
        title.setTextColor(Color.parseColor("#111827"));
        title.setGravity(Gravity.CENTER);
        box.addView(title);
        errorText = new TextView(this);
        errorText.setTextSize(15);
        errorText.setTextColor(Color.parseColor("#6b7280"));
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(0, dp(16), 0, dp(24));
        box.addView(errorText);
        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(v -> load());
        box.addView(retry);
        Button change = new Button(this);
        change.setText("Change server address");
        change.setOnClickListener(v -> askServerUrl());
        box.addView(change);
        box.setVisibility(View.GONE);
        return box;
    }

    void askServerUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl());
        input.setSelectAllOnFocus(true);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(dp(20), dp(8), dp(20), 0);
        wrap.addView(input);
        new AlertDialog.Builder(this)
                .setTitle("Server address")
                .setMessage("The web address where your booking system is hosted.")
                .setView(wrap)
                .setPositiveButton("Save", (d, w) -> {
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) return;
                    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
                    web.clearHistory();
                    load();
                })
                .setNeutralButton("Reset", (d, w) -> {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_URL).apply();
                    load();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app found to open this", Toast.LENGTH_SHORT).show();
        }
    }

    int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__androidBack ? window.__androidBack() : false", value -> {
            if ("true".equals(value)) return;
            if (web.canGoBack()) web.goBack();
            else MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    class Bridge {
        @JavascriptInterface
        public void setStatusBar(final String color) {
            runOnUiThread(() -> {
                try { getWindow().setStatusBarColor(Color.parseColor(color)); } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void share(String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(send, "Send confirmation"));
        }

        @JavascriptInterface
        public void saveFile(String filename, String mime, String content) {
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download");
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                            os.write(content.getBytes(StandardCharsets.UTF_8));
                        }
                        Toast.makeText(MainActivity.this, "Saved to Downloads: " + filename, Toast.LENGTH_LONG).show();
                    } else {
                        share(content);
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Could not save file", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(MainActivity.this::askServerUrl);
        }

        @JavascriptInterface
        public String serverUrl() {
            return MainActivity.this.serverUrl();
        }
    }
}
