package com.iproute.calc;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 纯 WebView 壳：加载 assets/index.html（自包含测算应用，无后端）。
 * - setDomStorageEnabled 必须开：费率库本地修改保存在 localStorage
 * - setTextZoom(100) 固定缩放：避免系统字体放大破坏移动端布局
 */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    /** 返回键：页面有可后退的记录（如参数弹出面板压入的历史）时先在 WebView 内后退，否则按系统默认退出。 */
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}
