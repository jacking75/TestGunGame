import './ui/styles.css';
import { App } from './app/App';
import { host } from './platform/host';

const root = document.getElementById('app');
if (!root) throw new Error('#app 요소가 없습니다');
const app = new App(root);
app.start();

// 개발 서버에서만 자동 검증 스크립트가 내부 상태를 읽을 수 있게 한다(배포 빌드에서는 제거됨).
if (import.meta.env.DEV) (window as unknown as { __tgg: App }).__tgg = app;
// 실물 확인 기록: 개발 서버와 게임 실행 파일에서 남긴다(일반 브라우저 배포 빌드에서는 보낼 곳이 없다).
if (import.meta.env.DEV || host) void import('./dev/hwLog').then((m) => app.startHardwareLog(m.startHardwareLog));
