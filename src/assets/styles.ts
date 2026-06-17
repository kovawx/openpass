/**
 * 全局样式聚合入口。
 *
 * `virtual:uno.css` 必须只由「单个模块」导入一次：UnoCSS 的 vite 插件在
 * 检测到该虚拟模块被多个 importer 引入时会打印 "imported multiple times"
 * 警告（@unocss/vite 中硬编码，无开关）。WXT 的 popup / options / auth
 * 三个入口各自是独立 bundle，若每个 main.ts 都直接导入就会触发该警告。
 *
 * 因此把 UnoCSS 与 Tailwind 的全局样式统一在本模块导入，各入口只引本文件，
 * 使 UnoCSS 始终只看到唯一的 importer（本文件）。
 */
import 'virtual:uno.css';
import './index.css';
