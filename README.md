<h1 align="center">Switchboard</h1>

<h3 align="center">여러 Claude Code 세션을 한 화면에서 병렬로 굴리는 Windows 데스크톱 앱</h3>

<p align="center">
  <em>신호가 온 세션부터 연결한다 &mdash; 교환대(switchboard)처럼.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2011-0078d4?style=flat-square&logo=windows11&logoColor=white" alt="Windows 11">
  <img src="https://img.shields.io/badge/shell-Tauri%20v2-24c8db?style=flat-square&logo=tauri&logoColor=white" alt="Tauri v2">
  <img src="https://img.shields.io/badge/runtime-WSL2-e95420?style=flat-square&logo=ubuntu&logoColor=white" alt="WSL2">
  <img src="https://img.shields.io/badge/Node.js-22%2B-22c55e?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/status-v1%20(pre--installer)-eab308?style=flat-square" alt="Status: v1, no installer yet">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-1e3a5f?style=flat-square" alt="License: MIT"></a>
</p>

---

> **Based on [Codeman](https://github.com/Ark0N/Codeman) (MIT).**
> Switchboard는 Codeman을 포크해 UI/UX를 개편하고 Windows 데스크톱 앱으로 감싼 프로젝트입니다.
> 터미널 스트리밍, tmux 세션 유지, 에이전트 제어 같은 핵심 엔진은 원 프로젝트의 작업이며, 원본 README는
> [`README.codeman-upstream.md`](README.codeman-upstream.md)에 그대로 보존했습니다.

## 한눈에 보기

| 하고 싶은 것 | Switchboard가 하는 일 |
|---|---|
| 세션 여러 개를 동시에 돌리고 싶다 | **2·3·4분할, 가로·세로 분할**, 레이아웃 저장·복원 |
| 어느 세션이 나를 기다리는지 모르겠다 | **세션 레일**에 상태(실행·유휴·대기)·마지막 활동·작업 폴더를 한 줄 요약 |
| 사용량이 얼마나 남았는지 궁금하다 | **홈 대시보드**(첫 화면)에 사용량·세션 현황 |
| 폴더를 바꿔 가며 작업한다 | 패널 헤더의 **폴더 칩**으로 프로젝트 전환 (새 Claude 세션으로 안전하게 연결) |
| 작업 폴더를 고르고 싶다 | **Windows 탐색기 대화상자**로 선택, 서버가 한 번 더 검증 |
| 눈이 편한 화면을 쓰고 싶다 | 다크·라이트 테마, **Windows 테마 연동** (제목 표시줄 포함) |

## 주요 기능

### 🖥️ 분할 작업 화면
- 한 화면에 **2~4개 세션**을 나란히(또는 위아래로) 배치하고, 세션을 **드래그해서** 분할합니다.
- 패널마다 자체 헤더(세션 이름 · 상태 · 폴더 칩)가 있고, 레이아웃은 저장했다가 복원할 수 있습니다.

### 🚦 신호 우선 세션 레일
- 좌측 레일은 **세션만** 담습니다. 응답을 기다리는 세션이 먼저 보이도록 상태·시간·폴더를 보여 줍니다.
- 상세도는 설정에서 「간단히 / 자세히」로 바꿉니다.

### 🏠 홈 = 첫 화면
- 앱을 켜면 곧바로 **홈 대시보드**(사용량·세션 현황)가 열립니다. 고정 탭이라 닫을 수 없습니다.

### 📁 작업 폴더와 프로젝트 전환
- **설정 → 작업 폴더**에서 기본 경로와 등록 폴더(최대 20개)를 관리합니다.
- 패널 헤더의 폴더 칩으로 전환하면 확인 창이 뜹니다.
  **「새 세션으로」**(권장)는 기존 세션을 남기고 새 세션을 열고, **「이 세션 재시작」**은 새 세션을 먼저 연 뒤 기존 세션을 닫습니다.
  이미 끝난 세션은 확인 없이 바로 바뀝니다.
- 폴더 선택은 **Windows 탐색기 대화상자**입니다. 대화상자가 돌려준 경로는 요청일 뿐이고, 서버가 변환·검증(`too_broad`, `outside_roots`, `blocked` 등)한 뒤에만 사용합니다.

### 🎨 디자인 시스템
- 색은 역할(토큰)로만 쓰고, 터미널이 명도의 극단이 되도록 다크·라이트를 나란히 설계했습니다.
- 한국어가 기본 언어입니다. 키보드 접근성(포커스·대화상자 역할)을 지킵니다.

## 구조

```
┌────────────────────────── Windows ──────────────────────────┐
│  Switchboard.exe (Tauri v2, WebView2)                         │
│   창 · 서버 시작/종료 · 네이티브 폴더 대화상자                │
└───────────────┬──────────────────────────────────────────────┘
                │ wsl.exe --exec  (토큰은 stdin으로만 전달)
┌───────────────▼──────────────── WSL2 (Ubuntu) ──────────────┐
│  Codeman 서버 (Node.js, Fastify)  ←→  tmux 세션 ←→ Claude Code │
│   127.0.0.1 전용 · 실행마다 새 토큰 · Host/Origin 고정        │
└───────────────────────────────────────────────────────────────┘
```

- 서버는 **WSL 안에서** 돕니다(`node-pty`와 tmux가 Linux를 필요로 하기 때문). 데스크톱 셸은 창과 서버 실행기일 뿐입니다.
- 창을 닫으면 서버가 멈추지만 **tmux 세션은 건드리지 않습니다.**

## 보안 모델

이 서버는 셸을 실행합니다. **루프백(127.0.0.1)은 경계가 아닙니다.** PC의 모든 프로세스와 브라우저 탭이 접근할 수 있기 때문입니다. 그래서 데스크톱 모드는 다음을 강제합니다.

1. 모든 요청에 **실행마다 새로 만드는 토큰** 필요 (토큰은 argv가 아니라 stdin으로 전달, 주소창에 남기지 않음)
2. `Host`/`Origin`을 `127.0.0.1:<port>` / `localhost:<port>`로 고정, CORS 헤더 없음
3. `127.0.0.1` 이외에는 바인딩하지 않고 터널을 시작하지 않음
4. 창은 자신의 페이지와 로컬 서버로만 이동할 수 있고, 페이지가 쓸 수 있는 IPC는 **창 테마와 폴더 대화상자뿐**

자세한 내용: [`desktop/README.md`](desktop/README.md), [`docs/architecture-invariants.md`](docs/architecture-invariants.md)

## 시작하기 (개발 빌드)

> **현재 상태: v1, 설치 파일 없음.** 설치 프로그램(NSIS)과 첫 실행 점검은 v1.5/v2에서 진행합니다.
> 지금은 소스에서 직접 빌드해 실행합니다.

### 준비물

| 위치 | 필요한 것 |
|---|---|
| Windows 11 | WSL2 + Ubuntu, WebView2(Windows 11에 기본 포함) |
| Windows 11 | Visual Studio Build Tools(C++ 빌드 도구 + Windows SDK), Rust(MSVC), `cargo install tauri-cli --version "^2" --locked` |
| WSL (Ubuntu) | Node.js 22 이상, `tmux`, [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI |

### 실행

```bash
# 1) WSL 안에서: 의존성 설치
cd /mnt/<드라이브>/<경로>/switchboard
npm install
```

```powershell
# 2) Windows PowerShell에서: 빌드하고 실행 (격리된 개발 인스턴스, 포트 3601)
.\desktop\dev.ps1

# 이미 빌드했다면
.\desktop\dev.ps1 -NoBuild
.\desktop\dev.ps1 -Port 3650
```

`dev.ps1`은 개발용 데이터 폴더(`~/.codeman-sbdev`)와 tmux 소켓을 따로 쓰므로 **기존 Codeman 세션과 섞이지 않습니다.** 빌드 결과는 `%LOCALAPPDATA%\Switchboard\build-target`에 만들어집니다.

### 테스트

```bash
npm test                # 전체 (약 9분, 낮은 우선순위로 실행 권장)
npm run typecheck && npm run lint && npm run format:check
cd desktop/src-tauri && cargo test
```

## 알려진 한계

- **검증 범위**: Windows 11 한 대에서만 확인했습니다(제목 표시줄 다크 모드 연동 포함). 다른 PC·깨끗한 환경은 설치 검증을 보류했으므로 확인하지 못했습니다.
- **디버그 빌드 전용**: 앱 아이콘은 임시 그림입니다.
- **폴더 선택 루트**: 일부 경로 선택기는 원 프로젝트의 `/mnt/d` 드라이브 루트를 그대로 씁니다(첫 실행 시 작업 폴더 선택으로 대체 예정).
- **단일 창 보기**에는 폴더 전환 진입점이 없습니다(분할 패널 헤더에서 전환).
- 일부 생성 문구(예: 레일의 "just now")는 영어로 표시됩니다.

## 로드맵

- [ ] **v1.5 / v2** &mdash; NSIS 설치 파일, 리눅스 페이로드 동봉, 첫 실행 점검(작업 폴더 선택 포함)
- [ ] 정식 아이콘과 정보 화면
- [ ] 한국어 문구 원어민 검수

## 문서

| 문서 | 내용 |
|---|---|
| [`desktop/README.md`](desktop/README.md) | 데스크톱 셸 구조, 실행 흐름, `config.json`, 보안 |
| [`docs/architecture-invariants.md`](docs/architecture-invariants.md) | 서버 설계 불변 조건, 데스크톱 모드 |
| [`README.codeman-upstream.md`](README.codeman-upstream.md) | 원 프로젝트(Codeman) README |
| [`CHANGELOG.md`](CHANGELOG.md) | 변경 이력(원 프로젝트 기준) |

## 라이선스와 감사

[MIT](LICENSE). 원 프로젝트의 저작권 고지(`Copyright (c) 2024-2026 Codeman Contributors`)를 그대로 유지합니다.
훌륭한 기반을 만들어 준 [Codeman](https://github.com/Ark0N/Codeman) 기여자분들께 감사드립니다.

&ldquo;Claude&rdquo;는 Anthropic의 상표이며, 이 프로젝트는 Anthropic과 제휴하거나 보증받은 것이 아닙니다.
