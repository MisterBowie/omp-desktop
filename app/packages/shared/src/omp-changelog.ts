import type { ChangelogEntry, ChangelogLocale } from "./changelog.js";

const release = (highlights: string[]): readonly ChangelogEntry[] => [
  { version: "0.1.0", date: "2026-10-16", highlights },
];

/** OMP Desktop's independent release history starts at 0.1.0. */
export const ompChangelog: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  en: release([
    "Right-click HTML file references to choose the file manager, built-in browser or system default application.",
    "Start OMP Desktop's own release series at 0.1.0 with isolated projects, approvals and recoverable conversations.",
    "Use the colorful pixel π icon and receive language-server diagnostics after Write and Edit.",
    "Check stable updates and download releases from MisterBowie/omp-desktop on GitHub.",
  ]),
  "zh-CN": release([
    "右键 HTML 文件引用，可选择文件管理器、内置浏览器或系统默认应用打开。",
    "OMP Desktop 从 0.1.0 开始独立版本线，提供隔离项目、工具审批和可恢复会话。",
    "使用彩色像素 π 图标，Write/Edit 后显示语言服务器诊断。",
    "从 GitHub 的 MisterBowie/omp-desktop 检查稳定更新和下载新版本。",
  ]),
  "zh-TW": release([
    "右鍵 HTML 檔案參照，可選擇檔案管理員、內建瀏覽器或系統預設應用程式開啟。",
    "OMP Desktop 從 0.1.0 開始獨立版本線，提供隔離專案、工具審批和可復原對話。",
    "使用彩色像素 π 圖示，Write/Edit 後顯示語言伺服器診斷。",
    "從 GitHub 的 MisterBowie/omp-desktop 檢查穩定更新及下載新版本。",
  ]),
  de: release([
    "HTML-Dateiverweise per Rechtsklick im Dateimanager, integrierten Browser oder mit der Systemstandardanwendung öffnen.",
    "OMP Desktop startet seine eigene Versionsreihe bei 0.1.0 mit getrennten Projekten, Werkzeugfreigaben und wiederherstellbaren Unterhaltungen.",
    "Das farbige Pixel-π und Sprachserverdiagnosen nach Write und Edit sind enthalten.",
    "Stabile Updates und Downloads kommen von MisterBowie/omp-desktop auf GitHub.",
  ]),
  es: release([
    "Haz clic derecho en las referencias HTML para abrirlas en el gestor de archivos, el navegador integrado o la aplicación predeterminada del sistema.",
    "OMP Desktop inicia su propia serie en 0.1.0 con proyectos aislados, aprobaciones y conversaciones recuperables.",
    "Incluye el icono π de píxeles de colores y diagnósticos del servidor de lenguaje tras Write y Edit.",
    "Las actualizaciones estables y descargas proceden de MisterBowie/omp-desktop en GitHub.",
  ]),
  fr: release([
    "Ouvrez les références HTML par clic droit dans le gestionnaire de fichiers, le navigateur intégré ou l’application système par défaut.",
    "OMP Desktop démarre sa propre série en 0.1.0 avec projets isolés, autorisations et conversations récupérables.",
    "L’icône π en pixels colorés et les diagnostics du serveur de langage après Write et Edit sont inclus.",
    "Les mises à jour stables et téléchargements proviennent de MisterBowie/omp-desktop sur GitHub.",
  ]),
  ko: release([
    "HTML 파일 참조를 마우스 오른쪽 버튼으로 클릭해 파일 관리자, 내장 브라우저 또는 시스템 기본 앱으로 여세요.",
    "OMP Desktop은 격리된 프로젝트, 도구 승인, 복구 가능한 대화와 함께 자체 버전을 0.1.0부터 시작합니다.",
    "컬러 픽셀 π 아이콘과 Write/Edit 이후 언어 서버 진단을 제공합니다.",
    "GitHub의 MisterBowie/omp-desktop에서 안정 버전 업데이트를 확인하고 다운로드합니다.",
  ]),
  tr: release([
    "HTML dosya başvurularına sağ tıklayarak dosya yöneticisi, yerleşik tarayıcı veya sistemin varsayılan uygulamasıyla açın.",
    "OMP Desktop, yalıtılmış projeler, araç onayları ve kurtarılabilir konuşmalarla kendi sürüm serisini 0.1.0’dan başlatır.",
    "Renkli piksel π simgesi ve Write/Edit sonrasında dil sunucusu tanılamaları sunulur.",
    "Kararlı güncellemeler ve indirmeler GitHub’daki MisterBowie/omp-desktop üzerinden sağlanır.",
  ]),
};
