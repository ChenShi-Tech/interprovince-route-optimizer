import SwiftUI
import WebKit

/* WKWebView 壳：加载随包内置的 index.html（自包含单文件，数据内联，离线可用）。
   与安卓壳同构：本地 file:// 加载，无任何远程依赖。
   注意：file:// 环境下 isProxyEnv() 恒为 false，腾讯地图不可用，
   底图按应用内设计降级为内置 SVG 拓扑图；天地图需用户自行填 tk。 */
struct ShellView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero)
        wv.backgroundColor = .systemBackground
        wv.isOpaque = false
        if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            // allowingReadAccessTo 限定在资源目录内，满足 localStorage 与相对资源访问
            wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

@main
struct InterprovinceRouteApp: App {
    var body: some Scene {
        WindowGroup {
            ShellView()
                .ignoresSafeArea()
        }
    }
}
