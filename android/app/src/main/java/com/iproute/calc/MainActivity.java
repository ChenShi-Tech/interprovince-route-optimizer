package com.iproute.calc;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 纯 WebView 壳：加载 assets/index.html（自包含测算应用，无后端）。
 * - setDomStorageEnabled 必须开：费率库本地修改保存在 localStorage
 * - setTextZoom(100) 固定缩放：避免系统字体放大破坏移动端布局
 * - AndroidBridge.savePng：网架图快照导出兜底（design D5）。WebView 里 <a download> 没有
 *   下载处理器会被静默丢弃（真机实测），网页端检测到本桥时把 PNG 的 base64 交由原生落盘。
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
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
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

    /** 导出桥：只暴露一个 savePng(name, base64)，纯数据落地，不做任何页面控制。 */
    class Bridge {
        @JavascriptInterface
        public void savePng(String name, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    // Android 10+：MediaStore.Downloads 公共下载目录，应用无需存储权限
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(data);
                    os.close();
                    where = "下载目录";
                } else {
                    // API 26~28：写公共目录要运行时权限，壳保持零权限 → 落应用外部私有目录（文件管理器可达）
                    File dir = getExternalFilesDir(null);
                    if (dir == null) throw new IllegalStateException("外部存储不可用");
                    File f = new File(dir, name);
                    FileOutputStream fo = new FileOutputStream(f);
                    fo.write(data);
                    fo.close();
                    where = f.getAbsolutePath();
                }
                toast("已保存到" + where);
            } catch (Exception e) {
                toast("保存失败：" + e.getMessage());
            }
        }
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }
}
