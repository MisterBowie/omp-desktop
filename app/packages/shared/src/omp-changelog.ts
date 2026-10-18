import type { ChangelogEntry, ChangelogLocale } from "./changelog.js";

const release = (highlights: string[], previous: string[]): readonly ChangelogEntry[] => [
  { version: "0.1.1", date: "2026-10-19", highlights },
  { version: "0.1.0", date: "2026-10-16", highlights: previous },
];

/** OMP Desktop's independent release history starts at 0.1.0. */
export const ompChangelog: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  en: release([
    "View native session Todos, use /skill: commands, and see reply dates and project activity in the sidebar.",
    "Steer a running OMP turn, queue follow-ups, and compact conversations with cancellation support.",
    "Create isolated local Git worktree sessions, restore them, preview merges, and sync project commits.",
    "Preserve terminal turn states, drafts, and file results when asynchronous responses arrive after a session switch.",
    "Bound full-page browser screenshot dimensions to prevent oversized images from breaking model requests.",
  ], [
    "Start OMP Desktop's own release series at 0.1.0 with isolated projects, approvals and recoverable conversations.",
    "Use the colorful pixel π icon and receive language-server diagnostics after Write and Edit.",
    "Check stable updates and download releases from MisterBowie/omp-desktop on GitHub.",
  ]),
  "zh-CN": release([
    "查看原生会话 Todo，使用 /skill: 命令，并在侧栏查看回复日期和项目运行状态。",
    "运行中插话、排队跟进，支持手动压缩会话及取消。",
    "创建本地 Git worktree 隔离会话，支持恢复、预览合并和同步项目提交。",
    "修复迟到响应导致回合状态复活、草稿丢失及文件结果串会话的问题。",
    "限制浏览器整页截图尺寸，避免超大图片导致模型请求失败。",
  ], [
    "OMP Desktop 从 0.1.0 开始独立版本线，提供隔离项目、工具审批和可恢复会话。",
    "使用彩色像素 π 图标，Write/Edit 后显示语言服务器诊断。",
    "从 GitHub 的 MisterBowie/omp-desktop 检查稳定更新和下载新版本。",
  ]),
  "zh-TW": release([
    "查看原生對話 Todo、使用 /skill: 指令，並在側欄查看回覆日期和專案執行狀態。",
    "執行中插話、排隊跟進，支援手動壓縮對話及取消。",
    "建立本機 Git worktree 隔離對話，支援還原、預覽合併及同步專案提交。",
    "修正延遲回應導致回合狀態復活、草稿遺失及檔案結果跨對話的問題。",
    "限制瀏覽器整頁截圖尺寸，避免過大圖片導致模型請求失敗。",
  ], [
    "OMP Desktop 從 0.1.0 開始獨立版本線，提供隔離專案、工具審批和可復原對話。",
    "使用彩色像素 π 圖示，Write/Edit 後顯示語言伺服器診斷。",
    "從 GitHub 的 MisterBowie/omp-desktop 檢查穩定更新及下載新版本。",
  ]),
  de: release([
    "Native Sitzungsaufgaben und /skill:-Befehle sowie Antwortdaten und Projektaktivität in der Seitenleiste anzeigen.",
    "Laufende OMP-Runden steuern, Folgenachrichten einreihen und Unterhaltungen mit Abbruchmöglichkeit komprimieren.",
    "Isolierte lokale Git-Worktree-Sitzungen erstellen, wiederherstellen, Zusammenführungen prüfen und Projekt-Commits synchronisieren.",
    "Abgeschlossene Runden, Entwürfe und Dateiergebnisse bei verspäteten Antworten nach einem Sitzungswechsel bewahren.",
    "Die Abmessungen vollständiger Browser-Screenshots begrenzen, damit große Bilder keine Modellanfragen beschädigen.",
  ], [
    "OMP Desktop startet seine eigene Versionsreihe bei 0.1.0 mit getrennten Projekten, Werkzeugfreigaben und wiederherstellbaren Unterhaltungen.",
    "Das farbige Pixel-π und Sprachserverdiagnosen nach Write und Edit sind enthalten.",
    "Stabile Updates und Downloads kommen von MisterBowie/omp-desktop auf GitHub.",
  ]),
  es: release([
    "Consulta las tareas nativas, usa comandos /skill: y ve fechas de respuesta y actividad del proyecto en la barra lateral.",
    "Intervén en turnos OMP activos, encola mensajes de seguimiento y compacta conversaciones con opción de cancelar.",
    "Crea sesiones aisladas en worktrees Git locales, restáuralas, previsualiza fusiones y sincroniza commits del proyecto.",
    "Conserva estados finales, borradores y resultados de archivos cuando lleguen respuestas tras cambiar de sesión.",
    "Limita las dimensiones de las capturas completas del navegador para evitar errores por imágenes demasiado grandes.",
  ], [
    "OMP Desktop inicia su propia serie en 0.1.0 con proyectos aislados, aprobaciones y conversaciones recuperables.",
    "Incluye el icono π de píxeles de colores y diagnósticos del servidor de lenguaje tras Write y Edit.",
    "Las actualizaciones estables y descargas proceden de MisterBowie/omp-desktop en GitHub.",
  ]),
  fr: release([
    "Consultez les tâches natives, utilisez les commandes /skill: et affichez les dates de réponse et l’activité des projets dans la barre latérale.",
    "Intervenez dans un tour OMP actif, mettez les suivis en file et compactez les conversations avec possibilité d’annulation.",
    "Créez des sessions isolées dans des worktrees Git locaux, restaurez-les, prévisualisez les fusions et synchronisez les commits du projet.",
    "Préservez les états terminaux, brouillons et résultats de fichiers lors de réponses tardives après un changement de session.",
    "Limitez les dimensions des captures complètes du navigateur pour éviter les erreurs dues aux images trop grandes.",
  ], [
    "OMP Desktop démarre sa propre série en 0.1.0 avec projets isolés, autorisations et conversations récupérables.",
    "L’icône π en pixels colorés et les diagnostics du serveur de langage après Write et Edit sont inclus.",
    "Les mises à jour stables et téléchargements proviennent de MisterBowie/omp-desktop sur GitHub.",
  ]),
  ko: release([
    "기본 세션 Todo와 /skill: 명령을 사용하고 사이드바에서 응답 날짜와 프로젝트 실행 상태를 확인합니다.",
    "실행 중인 OMP 턴에 개입하고 후속 메시지를 대기열에 넣으며 취소 가능한 대화 압축을 사용합니다.",
    "로컬 Git worktree 격리 세션을 만들고 복원하며 병합 미리 보기와 프로젝트 커밋 동기화를 사용합니다.",
    "세션 전환 후 늦게 도착한 응답으로 완료 상태, 초안 또는 파일 결과가 잘못 변경되는 문제를 수정합니다.",
    "브라우저 전체 페이지 스크린샷 크기를 제한하여 큰 이미지로 인한 모델 요청 실패를 방지합니다.",
  ], [
    "OMP Desktop은 격리된 프로젝트, 도구 승인, 복구 가능한 대화와 함께 자체 버전을 0.1.0부터 시작합니다.",
    "컬러 픽셀 π 아이콘과 Write/Edit 이후 언어 서버 진단을 제공합니다.",
    "GitHub의 MisterBowie/omp-desktop에서 안정 버전 업데이트를 확인하고 다운로드합니다.",
  ]),
  tr: release([
    "Yerel oturum görevlerini, /skill: komutlarını, kenar çubuğunda yanıt tarihlerini ve proje etkinliğini görüntüleyin.",
    "Çalışan OMP turuna müdahale edin, takip iletilerini sıraya alın ve konuşmaları iptal desteğiyle sıkıştırın.",
    "Yalıtılmış yerel Git worktree oturumları oluşturun, geri yükleyin, birleştirmeyi önizleyin ve proje commitlerini eşitleyin.",
    "Oturum değişiminden sonra geç gelen yanıtlarda tamamlanmış tur durumlarını, taslakları ve dosya sonuçlarını koruyun.",
    "Çok büyük görüntülerin model isteklerini bozmasını önlemek için tam sayfa tarayıcı görüntülerinin boyutlarını sınırlayın.",
  ], [
    "OMP Desktop, yalıtılmış projeler, araç onayları ve kurtarılabilir konuşmalarla kendi sürüm serisini 0.1.0’dan başlatır.",
    "Renkli piksel π simgesi ve Write/Edit sonrasında dil sunucusu tanılamaları sunulur.",
    "Kararlı güncellemeler ve indirmeler GitHub’daki MisterBowie/omp-desktop üzerinden sağlanır.",
  ]),
};
