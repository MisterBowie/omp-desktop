import type { ChangelogEntry, ChangelogLocale } from "./changelog.js";

const unified014: Record<ChangelogLocale, string[]> = {
  "en": [
    "Fix first replies interrupted by automatic chat naming and keep the native session identity.",
    "Keep empty DeepSeek tool-call text empty instead of adding dots to model history.",
    "Use OMP for every new chat; retire Pi history import and remote Pi hosts.",
    "Fix automatic memory capture and preserve project, worktree and temporary scopes.",
    "Improve memory settings spacing, search controls and narrow-window layouts.",
    "Recognize published thinking levels and image/PDF capabilities while preserving manual overrides.",
    "Open HTML references in the file manager, built-in browser or system default app.",
    "Announce completion after durable turn settlement."
  ],
  "zh-CN": [
    "修复自动改名打断首次回复的问题，并保持原生会话身份。",
    "DeepSeek 无正文工具调用保持为空，不再向模型历史补点。",
    "新会话统一使用 OMP，关闭 Pi 历史导入和远程 Pi Host。",
    "修复自动记忆保存，正确保留项目、worktree 和临时会话范围。",
    "改善记忆设置间距、搜索控件与窄窗口布局。",
    "识别发布的思考档位和图片/PDF 能力，保留手动覆盖。",
    "HTML 引用可用文件管理器、内置浏览器或系统默认应用打开。",
    "回合持久化结算后再通知完成，避免恢复状态竞态。"
  ],
  "zh-TW": [
    "修正自動改名中斷首次回覆的問題，並保持原生對話身分。",
    "DeepSeek 無正文工具呼叫保持為空，不再向模型歷史補點。",
    "新對話統一使用 OMP，關閉 Pi 歷史匯入和遠端 Pi Host。",
    "修正自動記憶儲存，正確保留專案、worktree 與暫時對話範圍。",
    "改善記憶設定間距、搜尋控制項與窄視窗版面。",
    "辨識公布的思考等級與圖片/PDF 能力，保留手動覆寫。",
    "HTML 參照可用檔案管理員、內建瀏覽器或系統預設應用程式開啟。",
    "回合持久化結算後再通知完成，避免復原狀態競態。"
  ],
  "de": [
    "Unterbrechungen der ersten Antwort durch automatische Chatnamen beheben und die native Sitzungsidentität erhalten.",
    "Leeren DeepSeek-Werkzeugtext leer lassen, statt Punkte in den Modellverlauf einzufügen.",
    "Neue Chats verwenden OMP; Pi-Verlaufsimporte und entfernte Pi-Hosts entfallen.",
    "Automatische Erinnerungen reparieren und Projekt-, Worktree- und temporäre Bereiche erhalten.",
    "Abstände, Suche und schmale Fenster in den Erinnerungseinstellungen verbessern.",
    "Veröffentlichte Denkstufen und Bild-/PDF-Fähigkeiten erkennen und manuelle Werte behalten.",
    "HTML-Verweise im Dateimanager, integrierten Browser oder der Standardanwendung öffnen.",
    "Den Abschluss nach dauerhafter Speicherung des Durchlaufs melden."
  ],
  "es": [
    "Evita que el nombre automático interrumpa la primera respuesta y conserva la identidad de la sesión nativa.",
    "Mantiene vacío el texto de herramientas de DeepSeek sin añadir puntos al historial del modelo.",
    "Los chats nuevos usan OMP; se retiran la importación Pi y los hosts Pi remotos.",
    "Corrige la memoria automática y conserva los ámbitos de proyecto, worktree y chats temporales.",
    "Mejora el espaciado, la búsqueda y el diseño de ventanas estrechas en Memoria.",
    "Reconoce niveles de razonamiento y capacidades de imagen/PDF publicados y conserva los ajustes manuales.",
    "Abre referencias HTML en el gestor de archivos, navegador integrado o aplicación predeterminada.",
    "Notifica la finalización después de guardar el estado del turno."
  ],
  "fr": [
    "Empêche le nommage automatique d’interrompre la première réponse et conserve l’identité de la session native.",
    "Conserve le texte vide des appels d’outils DeepSeek sans ajouter de points à l’historique du modèle.",
    "Les nouveaux échanges utilisent OMP ; les imports Pi et les hôtes Pi distants sont retirés.",
    "Corrige la mémoire automatique et préserve les domaines projet, worktree et échange temporaire.",
    "Améliore les espacements, la recherche et les réglages Mémoire en fenêtre étroite.",
    "Reconnaît les niveaux de réflexion et capacités image/PDF publiés en préservant les choix manuels.",
    "Ouvre les références HTML dans le gestionnaire de fichiers, le navigateur intégré ou l’application par défaut.",
    "Annonce la fin du tour après l’enregistrement durable de son état."
  ],
  "ko": [
    "자동 대화 이름 지정이 첫 응답을 중단하는 문제를 수정하고 원래 세션 식별자를 유지합니다.",
    "DeepSeek 도구 호출의 빈 본문을 유지하고 모델 기록에 마침표를 추가하지 않습니다.",
    "새 대화는 OMP를 사용하며 Pi 기록 가져오기와 원격 Pi 호스트를 종료합니다.",
    "자동 메모리를 수정하고 프로젝트, worktree, 임시 대화 범위를 유지합니다.",
    "메모리 설정의 간격, 검색 및 좁은 창 레이아웃을 개선합니다.",
    "공개된 추론 단계와 이미지/PDF 기능을 인식하고 수동 설정을 유지합니다.",
    "HTML 참조를 파일 관리자, 내장 브라우저 또는 시스템 기본 앱으로 엽니다.",
    "턴 상태가 영구 저장된 후 완료를 알립니다."
  ],
  "tr": [
    "Otomatik sohbet adlandırmanın ilk yanıtı kesmesini düzeltir ve yerel oturum kimliğini korur.",
    "DeepSeek araç çağrılarının boş metnini korur, model geçmişine nokta eklemez.",
    "Yeni sohbetler OMP kullanır; Pi geçmiş içe aktarma ve uzak Pi sunucuları kaldırılır.",
    "Otomatik belleği düzeltir; proje, worktree ve geçici sohbet kapsamlarını korur.",
    "Bellek ayarlarındaki boşlukları, aramayı ve dar pencere düzenini iyileştirir.",
    "Yayımlanan düşünme düzeylerini ve görüntü/PDF yeteneklerini tanır, elle ayarları korur.",
    "HTML başvurularını dosya yöneticisi, yerleşik tarayıcı veya varsayılan uygulamada açar.",
    "Tamamlanmayı tur durumu kalıcı kaydedildikten sonra bildirir."
  ]
};

const memoryAndModels: Record<ChangelogLocale, string[]> = {
  "en": [
    "Choose automatic memory saving and recall independently in Settings, both off by default.",
    "Browse, search and clear memories isolated by project and worktree; disabling memory keeps saved data.",
    "Use provider-published context and output token limits while preserving manual overrides."
  ],
  "zh-CN": [
    "在设置中分别开启自动保存和自动读取记忆，两个开关默认关闭。",
    "按项目和 worktree 隔离记忆，支持查看、搜索与清空；关闭后保留已有数据。",
    "正确采用供应商发布的上下文与输出 Token 上限，并保留手动覆盖值。"
  ],
  "zh-TW": [
    "在設定中分別開啟自動儲存與自動讀取記憶，兩個開關預設關閉。",
    "依專案與 worktree 隔離記憶，支援檢視、搜尋與清除；關閉後保留已有資料。",
    "正確採用供應商公布的上下文與輸出 Token 上限，並保留手動覆寫值。"
  ],
  "de": [
    "Automatisches Speichern und Abrufen von Erinnerungen in den Einstellungen getrennt aktivieren; beide sind standardmäßig aus.",
    "Erinnerungen nach Projekt und Worktree getrennt durchsuchen und löschen; beim Deaktivieren bleiben die Daten erhalten.",
    "Veröffentlichte Kontext- und Ausgabelimits des Anbieters verwenden und manuelle Werte beibehalten."
  ],
  "es": [
    "Activa por separado el guardado y la recuperación automáticos de memoria en Ajustes; ambos están desactivados inicialmente.",
    "Consulta, busca y borra memorias aisladas por proyecto y worktree; desactivarlas conserva los datos.",
    "Usa los límites de contexto y salida publicados por el proveedor y conserva los ajustes manuales."
  ],
  "fr": [
    "Activez séparément la sauvegarde et le rappel automatiques de mémoire dans les réglages, désactivés par défaut.",
    "Consultez, recherchez et effacez les mémoires isolées par projet et worktree ; la désactivation conserve les données.",
    "Utilisez les limites de contexte et de sortie publiées par le fournisseur en conservant les valeurs manuelles."
  ],
  "ko": [
    "설정에서 자동 메모리 저장과 불러오기를 각각 켤 수 있으며 기본값은 모두 꺼짐입니다.",
    "프로젝트와 worktree별로 분리된 메모리를 조회, 검색, 삭제할 수 있고 기능을 꺼도 데이터는 유지됩니다.",
    "공급자가 공개한 컨텍스트 및 출력 토큰 제한을 사용하고 수동 설정값은 유지합니다."
  ],
  "tr": [
    "Otomatik bellek kaydını ve geri çağırmayı Ayarlar bölümünden ayrı ayrı açın; ikisi de varsayılan olarak kapalıdır.",
    "Proje ve worktree bazında yalıtılmış anıları görüntüleyin, arayın ve temizleyin; kapatmak kayıtlı verileri korur.",
    "Sağlayıcının yayımladığı bağlam ve çıktı token sınırlarını kullanın, elle girilen değerleri koruyun."
  ]
};

const fixes: Record<ChangelogLocale, string[]> = {
  "en": [
    "Prevent same-path host moves from deleting files and stop workspace diffs from executing Git text converters.",
    "Bound browser CDP operations, reject late actions, and stream MCP responses with timeout cancellation.",
    "Keep Pi-compatible tool messages paired, preserve project rules beside global instructions, and avoid double-counting reasoning tokens.",
    "Read and edit BOM-marked UTF-16 files through host tools while preserving encoding and line endings.",
    "Update affected renderer, runtime, and build dependencies with security fixes.",
  ],
  "zh-CN": [
    "修复宿主同路径移动导致文件丢失，并禁止工作区差异执行 Git 文本转换器。",
    "为浏览器 CDP 操作增加时限并拒绝迟到动作，MCP 支持增量流式回复与超时取消。",
    "修复 Pi 兼容工具消息重复、全局指令挤占项目规则，以及推理 Token 重复计数。",
    "宿主工具支持读写带 BOM 的 UTF-16 文件，保留编码、字节序及换行。",
    "更新受影响的渲染器、运行时与构建依赖，修补已公布的安全问题。",
  ],
  "zh-TW": [
    "修正宿主同路徑移動造成檔案遺失，並禁止工作區差異執行 Git 文字轉換器。",
    "為瀏覽器 CDP 操作加入時限並拒絕延遲動作，MCP 支援增量串流回覆與逾時取消。",
    "修正 Pi 相容工具訊息重複、全域指令擠占專案規則，以及推理 Token 重複計算。",
    "宿主工具支援讀寫帶 BOM 的 UTF-16 檔案，保留編碼、位元組順序與換行。",
    "更新受影響的渲染器、執行環境與建置相依套件，修補已公布的安全問題。",
  ],
  "de": [
    "Gleichpfad-Verschiebungen löschen keine Dateien mehr; Arbeitsbereich-Diffs führen keine Git-Textkonverter aus.",
    "Browser-CDP-Aufrufe erhalten Zeitlimits und verwerfen verspätete Aktionen; MCP verarbeitet Streams inkrementell und meldet Zeitüberschreitungen als Abbruch.",
    "Pi-kompatible Werkzeugnachrichten bleiben korrekt gepaart, Projektregeln behalten ein eigenes Budget und Reasoning-Tokens werden nur einmal gezählt.",
    "Host-Werkzeuge lesen und bearbeiten UTF-16-Dateien mit BOM unter Beibehaltung von Kodierung und Zeilenenden.",
    "Betroffene Renderer-, Laufzeit- und Build-Abhängigkeiten erhalten Sicherheitsupdates.",
  ],
  "es": [
    "Evita que los movimientos a la misma ruta borren archivos e impide que las diferencias ejecuten conversores de texto de Git.",
    "Limita las operaciones CDP, rechaza acciones tardías y procesa respuestas MCP incrementales con cancelación por tiempo agotado.",
    "Empareja los mensajes de herramientas compatibles con Pi, conserva el presupuesto de reglas del proyecto y evita contar dos veces los tokens de razonamiento.",
    "Las herramientas del host leen y editan archivos UTF-16 con BOM conservando la codificación y los saltos de línea.",
    "Actualiza las dependencias afectadas del renderizador, la ejecución y la compilación con correcciones de seguridad.",
  ],
  "fr": [
    "Empêche les déplacements vers le même chemin de supprimer des fichiers et les différences de lancer des convertisseurs Git.",
    "Limite la durée des appels CDP, refuse les actions tardives et traite les réponses MCP en continu avec annulation à expiration.",
    "Préserve les paires de messages des outils compatibles Pi, le budget des règles du projet et le comptage unique des tokens de raisonnement.",
    "Les outils hôtes lisent et modifient les fichiers UTF-16 avec BOM en préservant le codage et les fins de ligne.",
    "Met à jour les dépendances concernées du rendu, de l’exécution et de la compilation avec des correctifs de sécurité.",
  ],
  "ko": [
    "같은 경로로 이동할 때 파일이 삭제되는 문제를 수정하고 작업 공간 diff에서 Git 텍스트 변환기를 실행하지 않도록 합니다.",
    "브라우저 CDP 작업에 시간 제한을 두고 늦은 동작을 거부하며 MCP 응답을 점진적으로 처리하고 시간 초과를 취소로 알립니다.",
    "Pi 호환 도구 메시지의 짝을 유지하고 프로젝트 규칙의 별도 예산을 보장하며 추론 토큰 중복 계산을 방지합니다.",
    "호스트 도구에서 BOM이 있는 UTF-16 파일을 읽고 편집하며 인코딩과 줄바꿈을 보존합니다.",
    "영향받는 렌더러, 런타임 및 빌드 의존성을 보안 수정 버전으로 업데이트합니다.",
  ],
  "tr": [
    "Aynı yola taşımanın dosyaları silmesini ve çalışma alanı farklarının Git metin dönüştürücülerini çalıştırmasını önleyin.",
    "Tarayıcı CDP işlemlerini süreyle sınırlayın, geciken eylemleri reddedin ve MCP yanıtlarını zaman aşımı iptaliyle artımlı işleyin.",
    "Pi uyumlu araç mesajlarını eşleştirin, proje kurallarına ayrı bütçe ayırın ve akıl yürütme tokenlarının iki kez sayılmasını önleyin.",
    "Ana makine araçlarıyla BOM içeren UTF-16 dosyalarını kodlamayı ve satır sonlarını koruyarak okuyup düzenleyin.",
    "Etkilenen arayüz, çalışma zamanı ve derleme bağımlılıklarını güvenlik düzeltmeleriyle güncelleyin.",
  ],
};

const release = (locale: ChangelogLocale, highlights: string[], previous: string[]): readonly ChangelogEntry[] => [
  { version: "0.1.4", date: "2026-10-21", highlights: unified014[locale] },
  { version: "0.1.3", date: "2026-10-20", highlights: memoryAndModels[locale] },
  { version: "0.1.2", date: "2026-10-19", highlights: fixes[locale] },
  { version: "0.1.1", date: "2026-10-19", highlights },
  { version: "0.1.0", date: "2026-10-16", highlights: previous },
];

/** OMP Desktop's independent release history starts at 0.1.0. */
export const ompChangelog: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  en: release("en", [
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
  "zh-CN": release("zh-CN", [
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
  "zh-TW": release("zh-TW", [
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
  de: release("de", [
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
  es: release("es", [
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
  fr: release("fr", [
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
  ko: release("ko", [
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
  tr: release("tr", [
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
