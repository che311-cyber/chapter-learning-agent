import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 注意：本应用含 Phaser 游戏模式，刻意不使用 React.StrictMode。
// StrictMode 的「挂载→立即卸载→重挂载」会让第一个 Phaser 实例进入
// pendingDestroy 的僵尸状态（继续 boot 场景、抢写全局钩子与输入管线），
// 导致地图点击等交互时灵时不灵。游戏画布应用的标准做法是禁用之。
createRoot(document.getElementById('root')!).render(<App />)
