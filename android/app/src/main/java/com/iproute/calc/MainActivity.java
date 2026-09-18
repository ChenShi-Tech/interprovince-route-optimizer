package com.iproute.calc;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

import java.lang.ref.WeakReference;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 纯 WebView 壳：加载 assets/index.html（自包含测算应用，无后端）。
 * - setDomStorageEnabled 必须开：费率库本地修改、外观偏好等保存在 localStorage
 * - setTextZoom(100) 固定缩放：避免系统字体放大破坏移动端布局
 * - AndroidBridge.savePng：网架图快照导出兜底（design D5）。WebView 里 <a download> 没有
 *   下载处理器会被静默丢弃（真机实测），网页端检测到本桥时把 PNG 的 base64 交由原生落盘。
 * - 主题：res/values*（浅色 / 深色 / API 27+）给出启动时的系统栏颜色；页面加载后由网页经 IPRouteShell
 *   按实际主题（清晰浅色 / 清晰深色 / 科技）再同步一次，壳把这次的颜色记下来，下次冷启动在首帧前先铺上（见 restoreSystemBars）
 */
public class MainActivity extends Activity {

    /** 系统栏颜色只接受不透明的 #RRGGBB */
    static final Pattern HEX = Pattern.compile("^#[0-9A-Fa-f]{6}$");
    /** 记系统栏颜色的 SharedPreferences 文件：每套系统明暗一份，只有「颜色串 + 图标深浅」两个值，不存别的 */
    private static final String PREFS = "system_bars";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 必须在 setContentView 之前：窗口第一次绘制时状态栏、导航栏与窗口底色已是网页上次同步的主题色
        restoreSystemBars();
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        // WebView 默认白底：改透明，网页首帧绘制前露出的是窗口底色，而不是一块白。
        // 窗口底色不闪的前提：① 主题（values / values-night 的 page_bg）与 app 内选的明暗一致，或者
        // ② 网页曾在当前系统明暗下同步过系统栏，restoreSystemBars() 已把窗口底色换成那次的颜色。
        // 两条都不满足时（首次安装、或刚在另一种系统明暗下改了外观），这一次冷启动仍会先露出主题底色，
        // 直到 boot.js 的 applyTheme() 经 IPRouteShell 同步；此后恢复正常。
        web.setBackgroundColor(Color.TRANSPARENT);
        web.addJavascriptInterface(new SystemBarsBridge(this), "IPRouteShell");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    /**
     * 冷启动时按「当前系统明暗」那一份记录铺好系统栏与窗口底色；没有记录（首次安装）或记录损坏时沿用主题默认。
     *
     * 为什么按系统明暗分两份：默认外观「清晰 · 跟随系统」下，网页的颜色由系统明暗决定。只记一份的话，
     * 白天记下白色，晚上系统转深色后冷启动会先铺白色、再被网页改成深色——正是这里要避免的闪屏。
     * 分开记之后，每份记录对应「这种系统明暗下网页实际用的颜色」：选了科技 / 深色 / 浅色的用户，
     * 两份最终都会是网页固定的那一种颜色。
     *
     * 仍会闪一下的情况：
     * - 系统的启动预览窗（进程起来之前系统按 XML 主题画的那一帧，Android 12+ 是启动画面）只认 res/values*，
     *   app 内选的主题和系统明暗不一致时，这一帧仍是主题色，壳在代码里改不了；
     * - 某一份记录过期：在一种系统明暗下改了外观，另一种明暗下第一次冷启动仍按旧记录铺色，网页同步后即更新。
     */
    private void restoreSystemBars() {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String slot = slotOf(this);
        String hex = p.getString(slot + ".color", null);
        if (hex == null || !HEX.matcher(hex).matches()) return;
        int color = Color.parseColor(hex);
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        applySystemBars(this, color, p.getBoolean(slot + ".lightIcons", true));
    }

    /** 当前系统明暗对应的记录名：night / day */
    static String slotOf(Context c) {
        int night = c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES ? "night" : "day";
    }

    /**
     * 页面 → 壳的唯一桥（JS 名 IPRouteShell），只做一件事：改系统状态栏 / 导航栏的颜色与图标深浅。
     * 附带把这次的颜色记到本机（只存颜色串与图标深浅，供下次冷启动在首帧前铺色），不存页面的任何其它内容。
     *
     * ⚠ 安全边界：addJavascriptInterface 注入的对象对页面里的所有脚本都可见——包括网架图按需加载的
     * 第三方地图脚本（腾讯地图 / 天地图）。所以这个类只暴露一个改颜色的方法：入参严格校验，
     * 不读文件、不打开页面或 Intent、不返回任何数据；写入的只有上面那两个值，第三方脚本调用最多让下次启动的
     * 系统栏换个颜色。不要往这里加别的能力；确有需要请另开受控通道，并先评估第三方脚本可调用的风险。
     */
    static final class SystemBarsBridge {
        private final WeakReference<Activity> ref;

        SystemBarsBridge(Activity activity) {
            ref = new WeakReference<>(activity);
        }

        /**
         * @param hex        系统栏颜色，只接受 #RRGGBB（不透明）；不合规直接忽略，也不记录
         * @param lightIcons true = 浅色图标（配深色底），false = 深色图标（配浅色底）
         */
        @JavascriptInterface
        public void setSystemBars(String hex, boolean lightIcons) {
            if (hex == null || !HEX.matcher(hex).matches()) return;
            final int color = Color.parseColor(hex);
            final Activity a = ref.get();
            if (a == null) return;
            // SharedPreferences 可在任意线程写，apply() 异步落盘
            a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(slotOf(a) + ".color", hex.toUpperCase(Locale.ROOT))
                    .putBoolean(slotOf(a) + ".lightIcons", lightIcons)
                    .apply();
            // JS 桥方法跑在 WebView 的后台线程上，改窗口必须回主线程
            a.runOnUiThread(() -> applySystemBars(a, color, lightIcons));
        }
    }

    /**
     * 只用 API 26 起可用的接口（setSystemUiVisibility 在 API 30 起标为过时，但仍然生效）。
     *
     * 导航栏图标深浅：代码开关 SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR 在 API 26 就有，API 27 才有的是主题属性
     * windowLightNavigationBar（所以 XML 里只能写在 values-v27）。这里也按 27 门控是保守做法，让代码与主题 XML 一致：
     * API 26 上导航栏只在深色底时改色，浅色底一律不设浅色导航栏图标。
     * 已知现象：API 26 从「科技」切回「清晰」后，导航栏停在科技的深色（冷启动后是系统默认深色），不会变白。
     *
     * ⚠ targetSdk 升到 35 后，在 Android 15 及以上设备上系统强制全面屏（edge-to-edge），setStatusBarColor /
     * setNavigationBarColor 不再生效；
     * 届时系统栏同步要改成：按 WindowInsets 给内容区加内边距，状态栏 / 导航栏后面由页面按页头色自己绘制。
     */
    @SuppressWarnings("deprecation")
    static void applySystemBars(Activity a, int color, boolean lightIcons) {
        if (a.isFinishing() || a.isDestroyed()) return;
        Window w = a.getWindow();
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        w.setStatusBarColor(color);
        flags = lightIcons ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            // API 27+：与 values-v27 的 windowLightNavigationBar 一致，导航栏跟状态栏同色、同步图标深浅
            w.setNavigationBarColor(color);
            flags = lightIcons ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) : (flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        } else if (lightIcons) {
            // API 26：只在深色底（浅色图标，系统默认）时改导航栏颜色；浅色底时不设浅色导航栏图标（保守，见方法注释），
            // 导航栏保持原来的深色——设成白底又不切图标会看不见按钮
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
