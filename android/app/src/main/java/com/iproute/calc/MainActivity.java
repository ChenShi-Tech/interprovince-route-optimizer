package com.iproute.calc;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.lang.ref.WeakReference;
import java.util.regex.Pattern;

/**
 * 纯 WebView 壳：加载 assets/index.html（自包含测算应用，无后端）。
 * - setDomStorageEnabled 必须开：费率库本地修改、外观偏好等保存在 localStorage
 * - setTextZoom(100) 固定缩放：避免系统字体放大破坏移动端布局
 * - 主题：res/values*（浅色 / 深色 / API 27+）给出启动时的系统栏颜色；页面加载后由网页经 IPRouteShell
 *   按实际主题（清晰浅色 / 清晰深色 / 科技）再同步一次
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
        // WebView 默认白底：改透明，首帧绘制前露出主题的 windowBackground（= 页面底色），深色模式不闪白
        web.setBackgroundColor(Color.TRANSPARENT);
        web.addJavascriptInterface(new SystemBarsBridge(this), "IPRouteShell");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    /**
     * 页面 → 壳的唯一桥（JS 名 IPRouteShell），只做一件事：改系统状态栏 / 导航栏的颜色与图标深浅。
     *
     * ⚠ 安全边界：addJavascriptInterface 注入的对象对页面里的所有脚本都可见——包括网架图按需加载的
     * 第三方地图脚本（腾讯地图 / 天地图）。所以这个类只暴露一个改颜色的方法：入参严格校验，
     * 不读写文件、不打开页面或 Intent、不返回任何数据。不要往这里加别的能力；确有需要请另开受控通道，
     * 并先评估第三方脚本可调用的风险。
     */
    static final class SystemBarsBridge {
        private static final Pattern HEX = Pattern.compile("^#[0-9A-Fa-f]{6}$");
        private final WeakReference<Activity> ref;

        SystemBarsBridge(Activity activity) {
            ref = new WeakReference<>(activity);
        }

        /**
         * @param hex        系统栏颜色，只接受 #RRGGBB（不透明）；不合规直接忽略
         * @param lightIcons true = 浅色图标（配深色底），false = 深色图标（配浅色底）
         */
        @JavascriptInterface
        public void setSystemBars(String hex, boolean lightIcons) {
            if (hex == null || !HEX.matcher(hex).matches()) return;
            final int color = Color.parseColor(hex);
            final Activity a = ref.get();
            if (a == null) return;
            // JS 桥方法跑在 WebView 的后台线程上，改窗口必须回主线程
            a.runOnUiThread(() -> applySystemBars(a, color, lightIcons));
        }
    }

    /** 只用 API 26 起可用的接口（setSystemUiVisibility 在 API 30 起标为过时，但仍然生效）。 */
    @SuppressWarnings("deprecation")
    static void applySystemBars(Activity a, int color, boolean lightIcons) {
        if (a.isFinishing() || a.isDestroyed()) return;
        Window w = a.getWindow();
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        w.setStatusBarColor(color);
        flags = lightIcons ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            // 导航栏图标深浅从 API 27 起才能可靠设置
            w.setNavigationBarColor(color);
            flags = lightIcons ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) : (flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        } else if (lightIcons) {
            // API 26：只在深色底（浅色图标，系统默认）时改导航栏颜色；浅色底改不了图标，保持系统默认深色导航栏
            w.setNavigationBarColor(color);
        }
        decor.setSystemUiVisibility(flags);
    }

    /** 返回键：页面有可后退的记录（如参数 / 外观弹出面板压入的历史）时先在 WebView 内后退，否则按系统默认退出。 */
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
