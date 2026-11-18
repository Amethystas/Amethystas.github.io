# 三维模型

地址：<https://amethystas.github.io/>

用 `?id=24a3` 打开对应题目，也支持 `24a_3`、`24A3` 和旧的 `#24a_3` 链接。没有题号时留空；题号无效或加载失败时显示动图。

拖动旋转、右键平移、滚轮缩放。右侧四个按钮切换正交方向，固定方向显示实体预计算的可见线和隐藏线。自由旋转时显示CAD拓扑边；WebGL不可用时使用SVG。

## 本地运行

需要 Node.js 24。

```sh
npm ci
npm run dev
```

```sh
npm run check
npm run build
npm run preview
```

## 更新与发布

仓库为 `Amethystas/Amethystas.github.io`。GitHub Pages的发布来源选择GitHub Actions，推送 `main` 后自动构建和发布。

每题资源位于 `public/models/题号/`，包含GLB、拓扑边及主、左、俯、轴测四张SVG，清单在 `public/models/catalog.json`。更新模型时同时替换这六个文件、包围盒和清单中的版本值，然后运行检查再提交。不要单独替换GLB，否则工程线可能与实体不一致。

GLB单位为米，网页乘1000后与毫米单位的CAD投影对齐。这里只展示当前模型，不执行在线CAD计算。

发布流程依据 [Vite](https://vite.dev/guide/static-deploy.html#github-pages) 和 [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) 官方说明。
