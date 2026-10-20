import './ui/styles.css';
import { App } from './app/App';

const root = document.getElementById('app');
if (!root) throw new Error('#app 요소가 없습니다');
const app = new App(root);
app.start();

// 개발 서버에서만 자동 검증 스크립트가 내부 상태를 읽을 수 있게 한다(배포 빌드에서는 제거됨).
if (import.meta.env.DEV) (window as unknown as { __tgg: App }).__tgg = app;
