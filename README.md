# TestGunGame — Wii 리모컨을 PC 총 게임에 쓰는 방법

Wii 리모컨(+ 총 모양 케이스)과 일반 USB 센서바를 Windows PC 게임의 총 입력으로 쓰는 방법을 연구하고, 그 방법을 **문서와 테스트 프로그램**으로 남긴 저장소다. 상용 게임이 아니다. 다른 총 게임을 만들 때 이 저장소의 코드와 문서를 가져다 쓰는 것이 목적이다.

결론: **된다.** 드라이버·별도 프로그램 설치 없이 게임 안에서 리모컨을 등록·연결하고, 적외선(IR) 조준으로 실제 총처럼 플레이할 수 있음을 실물로 확인했다(2026-10-20~23, T01~T13 완료).

## 무엇을 먼저 읽나

| 하려는 일 | 읽을 문서 |
|---|---|
| Wii 리모컨을 PC에 연결하고 조준 좌표를 얻는 원리·순서·함정 | [Wii 리모컨 PC 연결과 보정 참고서](Wii-리모컨-PC-연결과-보정-3.md) |
| 새 게임에 이 코드를 가져다 쓰는 방법, 게임 설계 원칙, 모듈 구조 | [Wii 총 입력을 게임에 쓰는 방법](재사용-구조와-최종-판단-4.md) |
| 시험용 게임(레일 슈팅 1스테이지)의 화면·규칙 | [게임 화면과 플레이 명세](게임-화면과-플레이-명세-2.md) |
| 개발 과정, 결정 이유, 날짜별 실측 기록 전체 | [구현 계획과 검증 기록](구현-계획-1.md) |

## 들어 있는 프로그램

| 프로그램 | 용도 | 빌드·실행 |
|---|---|---|
| **TestGunGame** (`host/` + `src/`) | Wii 총으로 하는 시험용 게임. 레일 슈팅 1스테이지(A·B·C, 적 15명), 십자 버튼 자유 이동 시험장, 조준 보정, 정확도 측정, 입력 진단(F3) | `npm run app:build` → `npm run app` |
| **WiiHwTest** (`hwtest/`) | 새 리모컨·PC·센서바 조합이 쓸 만한지 화면 지시만 따라 한 번에 재는 검증 앱(약 10분). 리모컨 입력을 녹화한다 | `npm run hwtest:build` → `npm run hwtest` |

둘 다 Windows 실행 파일(C# .NET Framework 4.8 + WebView2) 안에 웹 화면(TypeScript·Three.js)을 띄운다. 창은 작업 표시줄이 보이는 최대화 창이다.

## 준비

- **장비:** Windows 10/11 PC(블루투스), 정품 Wii 리모컨(RVL-CNT-01), 일반 USB 센서바(모니터 위나 아래 가운데), 총 모양 케이스(없어도 됨). 구입 참고는 [참고서 0절](Wii-리모컨-PC-연결과-보정-3.md#0-필요한-장비).
- **빌드 도구:** Node.js 24 이상, .NET SDK. 실행하는 PC에는 Windows 기본 구성 외에 설치할 것이 없다.

```powershell
npm install
npm run app:build     # 게임 빌드 → host\bin\Release\net48\TestGunGame.exe (+ game\)
npm run app           # 게임 실행
npm run app:pack      # 다른 PC로 옮길 압축 파일 → release\TestGunGame-<버전>.zip (풀어서 바로 실행)
npm run hwtest:build  # 검증 앱 빌드 → hwtest\host\bin\Release\net48\WiiHwTest.exe
npm run hwtest        # 검증 앱 실행
```

개발할 때:

```powershell
npm run dev           # http://localhost:25001 (Chrome·Edge. 마우스 플레이, Wii는 WebHID)
npm run app:dev       # 개발 서버를 게임 실행 파일로 열기(블루투스 등록 가능, F12 개발자 도구)
npm test              # 단위 시험(프로토콜·보정·게임 규칙·자유 이동)
npm run verify:exe    # 빌드한 게임을 띄워 마우스·키보드로 끝까지 자동 플레이·점검 → logs\t10\result.json
npm run hwtest:verify # 검증 앱을 모의 입력으로 끝까지 진행
```

## 처음 연결하는 순서

1. 게임을 켜고 **게임 시작**(또는 **자유 이동 시험장**)을 누른다. 조작 방식에서 **Wii 총**을 고른다.
2. 리모컨 배터리 칸 안의 빨간 **SYNC** 버튼을 누른다. 게임이 블루투스 등록과 연결을 직접 한다. 한 번 등록하면 다음부터는 게임을 켠 뒤 **아무 버튼**이나 누르면 연결된다(PC 재부팅 후 포함).
3. 총을 화면 가운데로 향해 센서바 두 점을 잡는다.
4. 처음 한 번 버튼을 학습한다(방아쇠 → 엄폐 버튼 → + 버튼을 차례로 누름).
5. 화면의 5지점을 겨냥해 방아쇠를 당겨 보정한다. 창 크기가 바뀌면 다시 한다.

| 동작 | Wii 총 | 마우스·키보드 |
| --- | --- | --- |
| 조준 | 총을 화면으로 향한다 | 마우스 |
| 발사 | 방아쇠(B) | 왼쪽 버튼 |
| 엄폐·재장전 | 학습한 버튼(보통 A) 유지, 0.8초면 장전 | Space 또는 오른쪽 버튼 유지 |
| 일시정지 | + / − / HOME | Esc 또는 P |
| 이동(자유 이동 시험장) | 십자 버튼 | W A S D 또는 방향키 |
| 메뉴 선택 | 버튼을 겨냥하고 방아쇠 | 클릭 |

리모컨은 전원 버튼으로 꺼지지 않는다. 연결을 끊으려면 건전지를 뺀다.

## 문제가 생기면

- **기록 파일**이 원인을 거의 다 알려 준다: 게임 `%LOCALAPPDATA%\TestGunGame\logs\hw-check.log`, 검증 앱 `%LOCALAPPDATA%\WiiHwTest\logs\hw-test.log`(개발 서버는 저장소 `logs\`). 시각 `t`는 UTC다.
- **F3 진단 화면:** 조준 좌표, 리모컨 상태·배터리, IR 카메라에 보이는 점, 보고 빈도.
- **IR 점이 0개:** 센서바 USB 전원과 방향을 본다. 가까우면(1m) 화면 모서리에서 센서바가 리모컨 시야를 벗어나니 조금 물러난다.
- **등록이 안 됨:** 리모컨을 PC 가까이 두고 SYNC를 다시 누른다. Dolphin 등 리모컨을 쓰는 다른 프로그램을 끈다. 건전지를 뺐다 넣는다.
- **영구 등록 여부 확인:** `powershell -ExecutionPolicy Bypass -File scripts/bt-status.ps1` → `authenticated`가 0이 아니면 영구 등록이다.

## 이 PC에 남은 이전 시도 정리(선택)

처음에 시험한 Touchmote(마우스 변환 프로그램)는 자체 서명 루트 인증서·가상 드라이버가 필요해 쓰지 않는다([검증 기록 T03](구현-계획-1.md)). 남은 구성은 다음으로 지운 뒤 **설정 → 앱**에서 Touchmote를 제거한다.

```powershell
certutil -user -delkey 7409b7d5-8e75-4b80-ae90-9c11e157f164                      # 남은 서명용 개인 키 삭제
Remove-Item Cert:\CurrentUser\Root\CEC32DDA81D6049B674A7B9BC3EB12287B5B1448      # 자체 서명 루트 인증서 삭제(확인 창)
```
