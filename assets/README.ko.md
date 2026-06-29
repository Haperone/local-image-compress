# Local Image Compress

클라우드 서비스나 API 없이 컴퓨터의 Obsidian 보관함에서 PNG 및 JPEG 파일을 직접 압축합니다. 품질 저하 없이 이미지가 차지하는 디스크 공간을 30–70% 줄일 수 있습니다.

Read in your language: [English](https://github.com/Haperone/local-image-compress/blob/main/README.md) • [العربية](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ar.md) • [Deutsch](https://github.com/Haperone/local-image-compress/blob/main/assets/README.de.md) • [Español](https://github.com/Haperone/local-image-compress/blob/main/assets/README.es.md) • [فارسی](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fa.md) • [Français](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fr.md) • [Bahasa Indonesia](https://github.com/Haperone/local-image-compress/blob/main/assets/README.id.md) • [Italiano](https://github.com/Haperone/local-image-compress/blob/main/assets/README.it.md) • [Nederlands](https://github.com/Haperone/local-image-compress/blob/main/assets/README.nl.md) • [Polski](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pl.md) • [Português](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt.md) • [Português (Brasil)](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt-br.md) • [Русский](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ru.md) • [ไทย](https://github.com/Haperone/local-image-compress/blob/main/assets/README.th.md) • [Türkçe](https://github.com/Haperone/local-image-compress/blob/main/assets/README.tr.md) • [Українська](https://github.com/Haperone/local-image-compress/blob/main/assets/README.uk.md) • [Tiếng Việt](https://github.com/Haperone/local-image-compress/blob/main/assets/README.vi.md) • [日本語](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ja.md) • [한국어](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ko.md) • [中文简体](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-cn.md) • [中文繁體](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-tw.md)

![Local Image Compress features](https://raw.githubusercontent.com/Haperone/local-image-compress/main/assets/Features.gif)

### 목차
- [기능](#기능)
- [지원 형식](#지원-형식)
- [설정](#설정)
- [작동 방식](#작동-방식)
- [데이터 저장 및 백업](#데이터-저장-및-백업)
- [자동화](#자동화)
- [Paste Image Rename 연동](#paste-image-rename-연동)
- [개인정보 보호 및 외부 동작](#개인정보-보호-및-외부-동작)
- [팁](#팁)
- [자주 묻는 질문](#자주-묻는-질문)
- [라이선스](#라이선스)

### 기능
- **로컬 압축**: PNG 및 JPEG 이미지를 로컬에서 압축합니다.
- **명령**:
  - **노트의 모든 이미지 압축**: 활성 노트에서 참조하거나 사용하는 이미지를 처리합니다.
  - **폴더의 모든 이미지 압축**: 폴더를 선택하고 출력 폴더를 제외한 내부의 모든 지원 이미지를 압축합니다.
  - **보관함의 모든 이미지 압축**: 출력 폴더를 제외한 전체 보관함을 검사합니다.
  - **압축 파일 이동**: 압축 결과를 원본 위치로 옮깁니다. 이동 전에 원본과 압축 버전을 모두 백업합니다.
- **자동화**:
  - 새 파일이 추가될 때 자동 압축
  - 압축되지 않은 이미지 수가 임계값에 도달하고 사용자가 비활성 상태가 되면 백그라운드 압축
- **UI 및 편의성**:
  - 파일과 폴더용 컨텍스트 메뉴
  - 상세 툴팁이 있는 절약 공간 표시
  - 상태 표시줄 진행률
- **안전성 및 신뢰성**:
  - 처리된 파일 캐시와 캐시 백업
  - 압축 파일 이동 전 백업 및 자동 삭제

### 지원 형식
- PNG(`imagequant` WASM 파이프라인)
- JPEG/JPG(`mozjpeg` WASM 파이프라인)

WebP, GIF, BMP, HEIC/HEIF 및 AVIF는 이 릴리스에 해당 인코더가 포함되지 않아 의도적으로 건너뜁니다.

### 설정

| 설정 | 설명 | 유형/범위 | 기본값 |
|---|---|---|---|
| PNG 품질(최소-최대) | 손실 PNG 양자화 품질 범위 | 1-100(예: `65-80`) | `65-80` |
| JPEG 품질 | JPEG 압축 품질 | 1-95 | `85` |
| 허용 루트 | 압축이 허용되는 상대 경로. 비어 있음 = 전체 보관함 | 문자열 목록 | 비어 있음 |
| 출력 폴더 | 압축 파일 저장 폴더 | 문자열 | `Compressed` |
| 새 파일 자동 압축 | 새 이미지가 추가될 때 압축 | 불리언 | `false` |
| 백그라운드 압축 | 비활성 상태에서 백그라운드로 압축 | 불리언 | `true` |
| 백그라운드 임계값 | 자동 시작에 필요한 미압축 이미지 수 | 10-1000 | `50` |
| 비활성 임계값 | 백그라운드 압축 전 사용자 활동이 없는 시간 | 1-60분 | `2` |
| 백업 자동 보존 | 이동 전에 만든 오래된 백업을 자동 삭제 | 불리언 | `false` |
| 백업 보관 일수 | 자동 보존 사용 시 N일보다 오래된 이동 백업 삭제 | 1-365 | `30` |
| 압축 파일 자동 이동 | 시작 시 원본 이미지 위치로 옮겨 원본 교체 | 불리언 | `false` |
| 자동 이동 임계값 | 자동 이동을 시작하는 준비된 압축 파일 수 | 1-1000 | `50` |


### 작동 방식
1. 압축 파일은 원본 경로 구조를 유지하여 `Compressed` 폴더에 저장됩니다.
2. 캐시는 처리한 파일과 원본 크기를 기록하여 반복 압축을 방지하고 절약량을 정확히 계산합니다.
3. “압축 파일 이동”은 원본이 허용 루트 안에 있을 때 `Compressed`의 파일을 원래 위치로 되돌립니다. 이동 전에 백업을 만듭니다.

매우 작은 파일은 일반적으로 건너뜁니다(PNG `<5KB`, JPEG `<10KB`).

내부 안전 한도는 고정되어 있습니다. `100 MB`보다 큰 파일은 읽기 전에, `1억` 픽셀을 초과하는 이미지는 헤더 검증 후 건너뜁니다.

### 데이터 저장 및 백업
- **기본 캐시:** 플러그인 폴더에 저장됩니다.
- **캐시 백업:** `Vault/.local-image-compress/backups/cache/`에 저장되며 최대 50개 파일을 유지합니다.
- **이미지 백업:** `Vault/.local-image-compress/backups/originals/`에 저장되며 원본 교체 전에 생성됩니다.

### 자동화
- “백그라운드 압축”을 켜면 두 개의 슬라이더가 표시됩니다.
  - 백그라운드 압축 임계값: 10–1000개 이미지, 기본값 50.
  - 비활성 임계값: 1–60분, 기본값 2.
- “백업 보관 일수”를 켜면 보존 기간 슬라이더가 표시됩니다.
- “압축 파일 자동 이동”을 켜면 파일 수 임계값이 표시됩니다. 시작 시 `Compressed`의 파일 수가 임계값 이상이면 이동을 시작합니다.

### Paste Image Rename 연동

이 플러그인은 압축 또는 이동 중 타사 플러그인 `obsidian-paste-image-rename`을 일시적으로 비활성화합니다. 압축 출력과 원본을 연결하려면 새 파일 이름이 다른 플러그인에 의해 바뀌지 않아야 하므로 이 보호 기능은 끌 수 없습니다.

<details>
<summary>이 보호가 필요한 이유</summary>

필요한 이유:

- Paste Image Rename은 보관함에 이미지가 추가될 때 생성 후 약 1초 안에 실행되는 `vault.on("create")` 핸들러를 등록합니다. 이름이 `Pasted image `로 시작하는 파일에는 항상 작동하며, “Handle all attachments”가 켜져 있으면 모든 이미지에 작동합니다.
- 이 플러그인이 출력 폴더에 압축 사본을 쓰면 해당 핸들러가 실행됩니다. 활성 Markdown 보기가 있으면 출력 이름을 바꿔 이동에 필요한 연결을 깨뜨리거나 파일마다 이름 변경 대화 상자를 표시합니다. 활성 보기가 없으면 생성된 파일마다 `Error: No active file found` 알림을 표시하여 일괄 처리 중 인터페이스를 오류로 채웁니다.
- Obsidian에는 한 플러그인이 다른 플러그인을 일시 중지하도록 요청할 수 있는 공개 API가 없습니다. 따라서 이 플러그인 하나만 일시적으로 비활성화하는 것이 유일하게 신뢰할 수 있는 방법입니다.

안전한 처리:

- 알려진 ID `obsidian-paste-image-rename`만 압축 또는 이동 중에 영향을 받습니다.
- 필요한 경우 재시도하여 작업 후 복원하지만, 상태가 외부에서 변경되면 복원하지 않습니다. 보호기는 자신이 플러그인을 비활성화했는지 기록하며 그런 변경 후에는 복원을 시도하지 않습니다.
- 공개 대안이 없으므로 활성화와 비활성화에 Obsidian 내부 `app.plugins` API를 사용합니다. 기능 유무를 확인하고 오류를 정상적으로 처리합니다.

</details>

### 개인정보 보호 및 외부 동작

- **네트워크**: 실행 중 네트워크 요청이 없습니다. PNG/JPEG 코덱은 `main.js`에 포함되며 이미지는 업로드되지 않습니다.
- **원격 측정 및 광고**: 분석, 원격 측정, 충돌 보고, 추적, 동적 광고 또는 자동 업데이트 기능이 없습니다.
- **계정 및 결제**: 계정, 구독, 라이선스 키 또는 결제가 필요 없습니다. manifest의 선택적 후원 링크에 플러그인이 접근하지 않습니다.
- **보관함 파일**: 명령, 자동화 또는 허용 루트로 선택한 지원 이미지를 읽습니다. 설정된 보관함 상대 폴더에 출력하고, 백업을 만든 뒤 문서화된 이동 또는 자동 이동 절차로만 원본을 교체합니다.
- **로컬 상태**: 캐시 데이터는 플러그인 폴더에 저장됩니다. 캐시 및 이동 백업은 `Vault/.local-image-compress/backups/` 아래에 저장됩니다.
- **외부 파일**: 플러그인이 관리하는 데이터는 현재 보관함 안에 남습니다. “폴더 열기”는 운영 체제에 문서화된 백업 폴더 표시만 요청하며 데이터를 전송하지 않습니다.
- **다른 플러그인**: 위 설명처럼 `obsidian-paste-image-rename`을 일시적으로 비활성화한 뒤 변경 주체를 확인하여 복원할 수 있습니다.

### 팁
- 적절한 품질 범위: PNG `65-80`, JPEG `75-90`.
- `files/` 또는 `images/` 같은 특정 폴더만 압축하려면 “허용 루트”를 설정하세요.
- 보관함에 미압축 이미지가 많다면 백그라운드 압축을 사용하세요.

### 자주 묻는 질문
**WebAssembly 모듈 초기화에 실패했다고 표시됩니다.**
플러그인을 다시 로드하세요. 오류가 반복되면 Obsidian 버전, 플랫폼 및 콘솔 오류를 버그 보고서에 포함하세요.

**압축 파일은 어디에 저장되나요?**
기본적으로 `Compressed`에 저장됩니다. 원본을 교체하려면 “압축 파일 이동”을 사용하세요.

**절약량은 어떻게 계산하나요?**
캐시에 원본과 출력 크기가 있으면 정확합니다. 압축되지 않은 PNG/JPEG에는 상한이 있는 보수적 비율을 사용하며, 필요할 때 현재 압축 파일 크기를 디스크에서 읽습니다.

### 라이선스
GPL-3.0-or-later. 타사 라이선스 및 고지: [THIRD_PARTY_NOTICES.md](https://github.com/Haperone/local-image-compress/blob/main/THIRD_PARTY_NOTICES.md).
