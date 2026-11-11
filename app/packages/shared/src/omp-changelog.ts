import type { ChangelogEntry, ChangelogLocale } from "./changelog.js";

const unified018: Record<ChangelogLocale, string[]> = {
  "en": [
    "OMP chats run at the thinking level the composer shows, also after a model switch or a restart; a level the model does not offer moves to the nearest supported one instead of blocking the message.",
    "Provider retries show as a “Retrying in …” status with the attempt count instead of a stack of error cards, and the failed attempt a retry replaced is removed.",
    "The error card of a message that could not be sent stays in its place in the conversation instead of appearing under later replies.",
    "Reply text written before a tool that waits for approval no longer shows twice.",
    "When the model asks a question in an OMP chat, an answer typed under “Enter another answer” now reaches the model, which carries on replying, instead of ending the turn as interrupted.",
    "A message sent right after switching into Plan or Goal mode failed now reaches the model instead of being marked done without a reply."
  ],
  "zh-CN": [
    "OMP 会话按输入框显示的思考等级运行，换模型或重启后也一样；模型不支持的等级会改用最接近的可用等级，不再阻止发送。",
    "服务商重试显示为“将在…秒后重试”状态并标明次数，不再堆叠错误卡片；被重试取代的失败尝试会被移除。",
    "发送失败的消息，其错误卡片留在会话中原来的位置，不再出现在后续回复下方。",
    "等待审批的工具调用之前的回复文字不再重复显示。",
    "OMP 会话中模型提问时，在“输入其他答案”里填写的回答会交给模型继续回复，不再使这一轮以中断结束。",
    "切换到“规划”或“目标”模式失败后紧接着发送的消息会交给模型，不再没有回复就显示完成。"
  ],
  "zh-TW": [
    "OMP 對話依輸入框顯示的思考等級執行，換模型或重新啟動後也一樣；模型不支援的等級會改用最接近的可用等級，不再阻止傳送。",
    "服務商重試顯示為「將在…秒後重試」狀態並標明次數，不再堆疊錯誤卡片；被重試取代的失敗嘗試會被移除。",
    "傳送失敗的訊息，其錯誤卡片留在對話中原本的位置，不再出現在後續回覆下方。",
    "等待核准的工具呼叫之前的回覆文字不再重複顯示。",
    "OMP 對話中模型提問時，在「輸入其他答案」裡填寫的回答會交給模型繼續回覆，不再使這一輪以中斷結束。",
    "切換到「規劃」或「目標」模式失敗後緊接著傳送的訊息會交給模型，不再沒有回覆就顯示完成。"
  ],
  "de": [
    "OMP-Chats laufen mit der Denkstufe, die das Eingabefeld anzeigt, auch nach einem Modellwechsel oder Neustart; eine Stufe, die das Modell nicht anbietet, wechselt zur nächstliegenden unterstützten, statt die Nachricht zu blockieren.",
    "Wiederholungen beim Anbieter erscheinen als Status „Erneuter Versuch in …“ mit Versuchszähler statt als Stapel von Fehlerkarten, und der fehlgeschlagene Versuch, den eine Wiederholung ersetzt hat, wird entfernt.",
    "Die Fehlerkarte einer Nachricht, die nicht gesendet werden konnte, bleibt an ihrer Stelle im Gespräch, statt unter späteren Antworten zu erscheinen.",
    "Antworttext vor einem Tool, das auf Freigabe wartet, wird nicht mehr doppelt angezeigt.",
    "Stellt das Modell in einem OMP-Chat eine Frage, erreicht eine unter „Geben Sie eine andere Antwort ein“ eingegebene Antwort jetzt das Modell, das weiterantwortet, statt die Runde als unterbrochen zu beenden.",
    "Eine Nachricht, die direkt nach einem fehlgeschlagenen Wechsel in den Modus „Plan“ oder „Ziel“ gesendet wird, erreicht jetzt das Modell, statt ohne Antwort als erledigt zu gelten."
  ],
  "es": [
    "Los chats de OMP usan el nivel de razonamiento que muestra el compositor, también tras cambiar de modelo o reiniciar; un nivel que el modelo no ofrece pasa al compatible más cercano en lugar de bloquear el mensaje.",
    "Los reintentos del proveedor se muestran como un estado «Reintentando en…» con el número de intento en lugar de una pila de tarjetas de error, y se quita el intento fallido que un reintento sustituyó.",
    "La tarjeta de error de un mensaje que no se pudo enviar se queda en su lugar de la conversación en vez de aparecer bajo respuestas posteriores.",
    "El texto de respuesta escrito antes de una herramienta que espera aprobación ya no aparece dos veces.",
    "Cuando el modelo hace una pregunta en un chat de OMP, lo que se escribe en «Ingrese otra respuesta» ahora llega al modelo, que sigue respondiendo, en lugar de terminar el turno como interrumpido.",
    "Un mensaje enviado justo después de un cambio fallido al modo «Plan» o «Meta» ahora llega al modelo en lugar de marcarse como terminado sin respuesta."
  ],
  "fr": [
    "Les chats OMP utilisent le niveau de réflexion affiché dans la zone de saisie, y compris après un changement de modèle ou un redémarrage ; un niveau que le modèle ne propose pas passe au niveau pris en charge le plus proche au lieu de bloquer le message.",
    "Les nouvelles tentatives du fournisseur s’affichent comme un état « Nouvelle tentative dans … » avec le numéro de tentative au lieu d’une pile de cartes d’erreur, et la tentative échouée remplacée est retirée.",
    "La carte d’erreur d’un message qui n’a pas pu être envoyé reste à sa place dans la conversation au lieu d’apparaître sous les réponses suivantes.",
    "Le texte de réponse écrit avant un outil en attente d’approbation ne s’affiche plus deux fois.",
    "Quand le modèle pose une question dans un chat OMP, la réponse saisie sous « Entrez une autre réponse » parvient désormais au modèle, qui poursuit sa réponse, au lieu de terminer le tour comme interrompu.",
    "Un message envoyé juste après l’échec du passage au mode « Plan » ou « Objectif » parvient désormais au modèle au lieu d’être marqué comme terminé sans réponse."
  ],
  "ko": [
    "OMP 대화가 입력창에 표시된 사고 수준으로 실행되며, 모델을 바꾸거나 다시 시작한 뒤에도 같습니다. 모델이 지원하지 않는 수준은 메시지를 막지 않고 가장 가까운 지원 수준으로 바뀝니다.",
    "제공자 재시도가 오류 카드 더미 대신 시도 횟수가 표시된 ‘… 후 재시도’ 상태로 나타나며, 재시도로 대체된 실패한 시도는 제거됩니다.",
    "보내지 못한 메시지의 오류 카드가 이후 응답 아래로 가지 않고 대화의 원래 위치에 남습니다.",
    "승인을 기다리는 도구 호출 앞의 응답 텍스트가 더 이상 두 번 표시되지 않습니다.",
    "OMP 대화에서 모델이 질문할 때 ‘다른 답변 입력’에 적은 답이 이제 모델에 전달되어 응답이 이어지며, 더 이상 해당 차례가 중단된 채로 끝나지 않습니다.",
    "‘계획’ 또는 ‘목표’ 모드 전환이 실패한 직후 보낸 메시지가 이제 모델에 전달되며, 응답 없이 완료로 표시되지 않습니다."
  ],
  "tr": [
    "OMP sohbetleri, model değiştirildikten veya yeniden başlatıldıktan sonra da giriş alanında görünen düşünme düzeyiyle çalışır; modelin sunmadığı bir düzey mesajı engellemek yerine desteklenen en yakın düzeye geçer.",
    "Sağlayıcı yeniden denemeleri, hata kartı yığını yerine deneme sayısıyla birlikte “… içinde yeniden deneniyor” durumu olarak görünür ve yeniden denemenin yerini aldığı başarısız deneme kaldırılır.",
    "Gönderilemeyen bir mesajın hata kartı, sonraki yanıtların altında görünmek yerine sohbetteki yerinde kalır.",
    "Onay bekleyen bir araçtan önce yazılan yanıt metni artık iki kez görünmez.",
    "Model bir OMP sohbetinde soru sorduğunda “Başka bir yanıt girin” altına yazılan yanıt artık modele ulaşır ve model yanıtlamayı sürdürür; tur kesintiye uğramış olarak bitmez.",
    "“Plan” veya “Hedef” moduna geçiş başarısız olduktan hemen sonra gönderilen mesaj artık modele ulaşır; yanıt almadan tamamlandı olarak işaretlenmez."
  ]
};

const unified017: Record<ChangelogLocale, string[]> = {
  "en": [
    "Browse and install plugins from Claude Code–compatible marketplaces through OMP; installed plugins load in full in OMP chats, including their MCP servers and hooks, from the next message.",
    "Show the generation speed of OMP replies and a per-turn usage capsule with speed and token totals; hover it for the cache, input, and output breakdown.",
    "List the files OMP edits or writes in the Review tab, and add a collapsible “Changes this turn” card under each finished reply; right-click a file to open it or show it in its folder.",
    "OMP chats follow the desktop network setting (custom proxy, system proxy, or direct) from the next message; switching modes keeps the saved proxy address.",
    "Keep the context ring on the last reported usage while a reply streams instead of dropping to 0%.",
    "Bring open approval and question dialogs back after the window reloads, and keep a draft typed while a slash command runs.",
    "Keep sidebar row menus inside the window, show a compact relative time on sidebar sessions, and save project groups even when a stored folder was renamed or removed."
  ],
  "zh-CN": [
    "通过 OMP 浏览并安装 Claude Code 兼容市场中的插件；已安装的插件在 OMP 会话中完整加载，包括其 MCP 服务器与 hooks，下一条消息起生效。",
    "显示 OMP 回复的生成速度，并在每轮回复下显示用量胶囊（速度与 token 总数）；悬停可查看缓存、输入与输出明细。",
    "“审阅”标签列出 OMP 编辑或写入的文件；每条完成的回复下方新增可折叠的“本轮改动”卡片，右键文件可打开或在文件夹中打开。",
    "OMP 会话遵循桌面网络设置（自定义代理、系统代理或直连），下一条消息起生效；切换模式会保留已保存的代理地址。",
    "回复生成期间，上下文圆环保持显示最近一次报告的用量，不再跌到 0%。",
    "窗口重新加载后，未处理的审批与提问对话框会重新出现；斜杠命令运行期间输入的草稿会被保留。",
    "侧栏行菜单不再超出窗口；侧栏会话显示简短的相对时间；已保存的文件夹被改名或删除后，项目分组仍可保存。"
  ],
  "zh-TW": [
    "透過 OMP 瀏覽並安裝 Claude Code 相容市集中的外掛；已安裝的外掛在 OMP 對話中完整載入，包括其 MCP 伺服器與 hooks，下一則訊息起生效。",
    "顯示 OMP 回覆的生成速度，並在每輪回覆下顯示用量膠囊（速度與 token 總數）；滑鼠停留可查看快取、輸入與輸出明細。",
    "「審閱」分頁列出 OMP 編輯或寫入的檔案；每則完成的回覆下方新增可摺疊的「本輪改動」卡片，右鍵檔案可開啟或在資料夾中開啟。",
    "OMP 對話遵循桌面網路設定（自訂代理、系統代理或直連），下一則訊息起生效；切換模式會保留已儲存的代理位址。",
    "回覆生成期間，上下文圓環維持顯示最近一次回報的用量，不再跌到 0%。",
    "視窗重新載入後，未處理的核准與提問對話框會重新出現；斜線命令執行期間輸入的草稿會被保留。",
    "側邊欄列選單不再超出視窗；側邊欄對話顯示簡短的相對時間；已儲存的資料夾被改名或刪除後，專案群組仍可儲存。"
  ],
  "de": [
    "Plugins aus Claude Code–kompatiblen Marktplätzen über OMP durchsuchen und installieren; installierte Plugins werden ab der nächsten Nachricht vollständig in OMP-Chats geladen, einschließlich ihrer MCP-Server und Hooks.",
    "Die Generierungsgeschwindigkeit von OMP-Antworten und eine Verbrauchskapsel pro Durchlauf mit Geschwindigkeit und Token-Summe anzeigen; beim Überfahren erscheint die Aufteilung in Cache, Eingabe und Ausgabe.",
    "Der Tab „Überprüfen“ listet die Dateien, die OMP bearbeitet oder schreibt; unter jeder fertigen Antwort zeigt eine einklappbare Karte „Änderungen in diesem Durchlauf“ die Dateien, per Rechtsklick lassen sie sich öffnen oder im Ordner anzeigen.",
    "OMP-Chats folgen ab der nächsten Nachricht der Netzwerkeinstellung der App (eigener Proxy, System-Proxy oder direkt); beim Wechsel des Modus bleibt die gespeicherte Proxy-Adresse erhalten.",
    "Der Kontextring behält während einer laufenden Antwort den zuletzt gemeldeten Verbrauch, statt auf 0 % zu fallen.",
    "Offene Freigabe- und Rückfragedialoge erscheinen nach dem Neuladen des Fensters wieder; ein während eines Slash-Befehls getippter Entwurf bleibt erhalten.",
    "Menüs von Seitenleistenzeilen bleiben im Fenster, Sitzungen in der Seitenleiste zeigen eine kurze relative Zeit, und Projektgruppen lassen sich auch speichern, wenn ein gespeicherter Ordner umbenannt oder entfernt wurde."
  ],
  "es": [
    "Explora e instala plugins de marketplaces compatibles con Claude Code a través de OMP; los plugins instalados se cargan por completo en los chats de OMP, incluidos sus servidores MCP y hooks, desde el siguiente mensaje.",
    "Muestra la velocidad de generación de las respuestas de OMP y una cápsula de uso por turno con la velocidad y el total de tokens; al pasar el cursor se ve el desglose de caché, entrada y salida.",
    "La pestaña Revisar enumera los archivos que OMP edita o escribe, y bajo cada respuesta terminada aparece una tarjeta plegable «Cambios de este turno»; con clic derecho puedes abrir un archivo o mostrarlo en la carpeta.",
    "Los chats de OMP siguen la configuración de red de la app (proxy personalizado, proxy del sistema o directo) desde el siguiente mensaje; al cambiar de modo se conserva la dirección del proxy guardada.",
    "El anillo de contexto mantiene el último uso informado mientras se genera una respuesta, en lugar de caer al 0 %.",
    "Los diálogos de aprobación y de pregunta abiertos vuelven a aparecer tras recargar la ventana, y se conserva el borrador escrito mientras se ejecuta un comando de barra.",
    "Los menús de las filas de la barra lateral se mantienen dentro de la ventana, las sesiones muestran un tiempo relativo breve y los grupos de proyectos se guardan aunque una carpeta guardada se haya renombrado o eliminado."
  ],
  "fr": [
    "Parcourez et installez via OMP des plugins issus de marketplaces compatibles Claude Code ; les plugins installés sont chargés entièrement dans les chats OMP, y compris leurs serveurs MCP et hooks, dès le message suivant.",
    "Affichage de la vitesse de génération des réponses OMP et d’une capsule d’utilisation par tour avec la vitesse et le total de tokens ; le survol détaille le cache, l’entrée et la sortie.",
    "L’onglet Réviser liste les fichiers modifiés ou écrits par OMP, et une carte repliable « Modifications de ce tour » apparaît sous chaque réponse terminée ; un clic droit sur un fichier permet de l’ouvrir ou de l’afficher dans le dossier.",
    "Les chats OMP suivent le réglage réseau de l’app (proxy personnalisé, proxy système ou direct) dès le message suivant ; changer de mode conserve l’adresse du proxy enregistrée.",
    "L’anneau de contexte conserve la dernière utilisation signalée pendant la génération d’une réponse au lieu de tomber à 0 %.",
    "Les dialogues d’approbation et de question ouverts réapparaissent après le rechargement de la fenêtre, et un brouillon saisi pendant une commande slash est conservé.",
    "Les menus des lignes de la barre latérale restent dans la fenêtre, les sessions affichent un temps relatif court et les groupes de projets s’enregistrent même si un dossier enregistré a été renommé ou supprimé."
  ],
  "ko": [
    "OMP를 통해 Claude Code 호환 마켓플레이스의 플러그인을 찾아보고 설치할 수 있습니다. 설치한 플러그인은 다음 메시지부터 MCP 서버와 hooks를 포함해 OMP 대화에 모두 로드됩니다.",
    "OMP 응답의 생성 속도와 턴별 사용량 캡슐(속도, 토큰 합계)을 표시합니다. 마우스를 올리면 캐시, 입력, 출력 내역을 볼 수 있습니다.",
    "검토 탭에 OMP가 편집하거나 작성한 파일이 표시되고, 완료된 응답 아래에 접을 수 있는 ‘이번 턴의 변경’ 카드가 추가됩니다. 파일을 오른쪽 클릭하면 열거나 폴더에서 볼 수 있습니다.",
    "OMP 대화는 다음 메시지부터 앱의 네트워크 설정(사용자 지정 프록시, 시스템 프록시, 직접 연결)을 따릅니다. 모드를 바꿔도 저장된 프록시 주소는 유지됩니다.",
    "응답이 생성되는 동안 컨텍스트 링이 0%로 떨어지지 않고 마지막으로 보고된 사용량을 유지합니다.",
    "창을 다시 불러온 뒤에도 열려 있던 승인 및 질문 대화 상자가 다시 표시되고, 슬래시 명령 실행 중에 입력한 초안이 유지됩니다.",
    "사이드바 행 메뉴가 창 밖으로 벗어나지 않고, 사이드바 세션에 짧은 상대 시간이 표시되며, 저장된 폴더의 이름이 바뀌거나 삭제되어도 프로젝트 그룹을 저장할 수 있습니다."
  ],
  "tr": [
    "Claude Code uyumlu pazar yerlerindeki eklentiler OMP üzerinden göz atılıp kurulabilir; kurulan eklentiler bir sonraki mesajdan itibaren MCP sunucuları ve hook'ları dahil OMP sohbetlerinde tamamen yüklenir.",
    "OMP yanıtlarının üretim hızı ve her tur için hız ile toplam token gösteren bir kullanım kapsülü görüntülenir; üzerine gelindiğinde önbellek, girdi ve çıktı dökümü görünür.",
    "İnceleme sekmesi OMP'nin düzenlediği veya yazdığı dosyaları listeler; tamamlanan her yanıtın altına daraltılabilir bir “Bu turdaki değişiklikler” kartı eklenir, bir dosyaya sağ tıklayarak onu açabilir veya klasörde gösterebilirsiniz.",
    "OMP sohbetleri bir sonraki mesajdan itibaren uygulamanın ağ ayarını (özel proxy, sistem proxy'si veya doğrudan) izler; mod değiştirildiğinde kayıtlı proxy adresi korunur.",
    "Bağlam halkası, yanıt üretilirken %0'a düşmek yerine en son bildirilen kullanımı gösterir.",
    "Açık onay ve soru pencereleri pencere yeniden yüklendikten sonra yeniden görünür; bir eğik çizgi komutu çalışırken yazılan taslak korunur.",
    "Kenar çubuğu satır menüleri pencerenin içinde kalır, kenar çubuğundaki oturumlar kısa bir göreli zaman gösterir ve kayıtlı bir klasör yeniden adlandırılsa veya kaldırılsa bile proje grupları kaydedilebilir."
  ]
};

const unified016: Record<ChangelogLocale, string[]> = {
  "en": [
    "Add a close button to chat error cards; a closed card stays hidden until the app restarts, and the reply before it stays visible."
  ],
  "zh-CN": [
    "会话中的错误卡片新增关闭按钮；关闭后在应用重启前不再显示，之前的回复保持可见。"
  ],
  "zh-TW": [
    "對話中的錯誤卡片新增關閉按鈕；關閉後在應用程式重新啟動前不再顯示，先前的回覆保持可見。"
  ],
  "de": [
    "Fehlerkarten im Chat lassen sich schließen; eine geschlossene Karte bleibt bis zum Neustart der App ausgeblendet, die vorherige Antwort bleibt sichtbar."
  ],
  "es": [
    "Las tarjetas de error del chat se pueden cerrar; una tarjeta cerrada permanece oculta hasta reiniciar la app y la respuesta anterior sigue visible."
  ],
  "fr": [
    "Les cartes d’erreur du chat peuvent être fermées ; une carte fermée reste masquée jusqu’au redémarrage de l’app et la réponse précédente reste visible."
  ],
  "ko": [
    "대화의 오류 카드를 닫을 수 있습니다. 닫은 카드는 앱을 다시 시작할 때까지 숨겨지며 이전 응답은 계속 표시됩니다."
  ],
  "tr": [
    "Sohbetteki hata kartları kapatılabilir; kapatılan kart uygulama yeniden başlatılana kadar gizli kalır, önceki yanıt görünür kalır."
  ]
};

const unified015: Record<ChangelogLocale, string[]> = {
  "en": [
    "Load enabled user subagents into OMP with their configured models and native tool grants; refresh edits without changing chat identity.",
    "Send pasted and attached images to OMP chats inline for image-capable models, as file references otherwise, and keep them visible after reopening.",
    "Keep global instructions in OMP Desktop’s own data folder and apply them to every OMP chat.",
    "Hide OAuth sign-in, which OMP chats cannot use; existing vendor accounts can still be removed.",
    "Fix first replies interrupted by automatic chat naming and keep the native session identity.",
    "Keep empty DeepSeek tool-call text empty instead of adding dots to model history."
  ],
  "zh-CN": [
    "已启用的用户子智能体接入 OMP，使用指定模型与原生工具授权；配置更新保留原会话身份。",
    "OMP 会话支持粘贴和附加图片：支持图片的模型直接接收图片，其他模型改用文件引用；重新打开后图片仍可见。",
    "全局指令改存 OMP Desktop 自己的数据目录，并作用于所有 OMP 会话。",
    "隐藏 OMP 会话无法使用的 OAuth 登录入口；已有厂商账户仍可删除。",
    "修复自动改名打断首次回复的问题，并保持原生会话身份。",
    "DeepSeek 无正文工具调用保持为空，不再向模型历史补点。"
  ],
  "zh-TW": [
    "已啟用的使用者子代理接入 OMP，使用指定模型與原生工具授權；設定更新保留原對話身分。",
    "OMP 對話支援貼上與附加圖片：支援圖片的模型直接接收圖片，其他模型改用檔案參照；重新開啟後圖片仍可見。",
    "全域指令改存於 OMP Desktop 自己的資料資料夾，並套用至所有 OMP 對話。",
    "隱藏 OMP 對話無法使用的 OAuth 登入入口；既有廠商帳戶仍可刪除。",
    "修正自動改名中斷首次回覆的問題，並保持原生對話身分。",
    "DeepSeek 無正文工具呼叫保持為空，不再向模型歷史補點。"
  ],
  "de": [
    "Aktivierte Benutzeragenten mit ihren Modellen und nativen Werkzeugrechten in OMP laden; Änderungen erhalten die Chatidentität.",
    "Eingefügte und angehängte Bilder an OMP-Chats senden: direkt an bildfähige Modelle, sonst als Dateiverweis; nach dem erneuten Öffnen bleiben sie sichtbar.",
    "Globale Anweisungen im eigenen Datenordner von OMP Desktop speichern und auf alle OMP-Chats anwenden.",
    "Die für OMP-Chats unbrauchbare OAuth-Anmeldung ausblenden; vorhandene Anbieterkonten lassen sich weiterhin entfernen.",
    "Unterbrechungen der ersten Antwort durch automatische Chatnamen beheben und die native Sitzungsidentität erhalten.",
    "Leeren DeepSeek-Werkzeugtext leer lassen, statt Punkte in den Modellverlauf einzufügen."
  ],
  "es": [
    "Carga los subagentes de usuario activos en OMP con sus modelos y permisos nativos; los cambios conservan la identidad del chat.",
    "Envía imágenes pegadas o adjuntas a los chats OMP: directamente a modelos compatibles con imágenes y como referencia de archivo en otro caso; siguen visibles al reabrir.",
    "Guarda las instrucciones globales en la carpeta de datos propia de OMP Desktop y las aplica a todos los chats OMP.",
    "Oculta el inicio de sesión OAuth, que los chats OMP no pueden usar; las cuentas de proveedor existentes aún se pueden eliminar.",
    "Evita que el nombre automático interrumpa la primera respuesta y conserva la identidad de la sesión nativa.",
    "Mantiene vacío el texto de herramientas de DeepSeek sin añadir puntos al historial del modelo."
  ],
  "fr": [
    "Charge les sous-agents utilisateur actifs dans OMP avec leurs modèles et droits natifs ; les modifications conservent l’identité du chat.",
    "Envoie les images collées ou jointes aux échanges OMP : directement aux modèles compatibles, sinon comme référence de fichier ; elles restent visibles à la réouverture.",
    "Conserve les instructions globales dans le dossier de données propre à OMP Desktop et les applique à tous les échanges OMP.",
    "Masque la connexion OAuth, inutilisable dans les échanges OMP ; les comptes fournisseur existants restent supprimables.",
    "Empêche le nommage automatique d’interrompre la première réponse et conserve l’identité de la session native.",
    "Conserve le texte vide des appels d’outils DeepSeek sans ajouter de points à l’historique du modèle."
  ],
  "ko": [
    "활성 사용자 하위 에이전트를 지정 모델과 기본 도구 권한으로 OMP에 연결하고 설정 변경 시 대화 식별자를 유지합니다.",
    "붙여 넣거나 첨부한 이미지를 OMP 대화로 보냅니다. 이미지 지원 모델에는 직접, 그 외에는 파일 참조로 보내며 다시 열어도 표시됩니다.",
    "전역 지침을 OMP Desktop 전용 데이터 폴더에 저장하고 모든 OMP 대화에 적용합니다.",
    "OMP 대화에서 사용할 수 없는 OAuth 로그인을 숨깁니다. 기존 공급자 계정은 계속 삭제할 수 있습니다.",
    "자동 대화 이름 지정이 첫 응답을 중단하는 문제를 수정하고 원래 세션 식별자를 유지합니다.",
    "DeepSeek 도구 호출의 빈 본문을 유지하고 모델 기록에 마침표를 추가하지 않습니다."
  ],
  "tr": [
    "Etkin kullanıcı alt ajanlarını modelleri ve yerel araç izinleriyle OMP’ye yükler; değişikliklerde sohbet kimliğini korur.",
    "Yapıştırılan ve eklenen görüntüleri OMP sohbetlerine gönderir: görüntü destekleyen modellere doğrudan, diğerlerine dosya başvurusu olarak; yeniden açınca görünür kalır.",
    "Genel talimatları OMP Desktop’ın kendi veri klasöründe tutar ve tüm OMP sohbetlerine uygular.",
    "OMP sohbetlerinin kullanamadığı OAuth girişini gizler; mevcut sağlayıcı hesapları yine silinebilir.",
    "Otomatik sohbet adlandırmanın ilk yanıtı kesmesini düzeltir ve yerel oturum kimliğini korur.",
    "DeepSeek araç çağrılarının boş metnini korur, model geçmişine nokta eklemez."
  ]
};

const unified014: Record<ChangelogLocale, string[]> = {
  "en": [
    "Use OMP for every new chat; retire Pi history import and remote Pi hosts.",
    "Fix automatic memory capture and preserve project, worktree and temporary scopes.",
    "Improve memory settings spacing, search controls and narrow-window layouts.",
    "Recognize published thinking levels and image/PDF capabilities while preserving manual overrides.",
    "Open HTML references in the file manager, built-in browser or system default app.",
    "Announce completion after durable turn settlement."
  ],
  "zh-CN": [
    "新会话统一使用 OMP，关闭 Pi 历史导入和远程 Pi Host。",
    "修复自动记忆保存，正确保留项目、worktree 和临时会话范围。",
    "改善记忆设置间距、搜索控件与窄窗口布局。",
    "识别发布的思考档位和图片/PDF 能力，保留手动覆盖。",
    "HTML 引用可用文件管理器、内置浏览器或系统默认应用打开。",
    "回合持久化结算后再通知完成，避免恢复状态竞态。"
  ],
  "zh-TW": [
    "新對話統一使用 OMP，關閉 Pi 歷史匯入和遠端 Pi Host。",
    "修正自動記憶儲存，正確保留專案、worktree 與暫時對話範圍。",
    "改善記憶設定間距、搜尋控制項與窄視窗版面。",
    "辨識公布的思考等級與圖片/PDF 能力，保留手動覆寫。",
    "HTML 參照可用檔案管理員、內建瀏覽器或系統預設應用程式開啟。",
    "回合持久化結算後再通知完成，避免復原狀態競態。"
  ],
  "de": [
    "Neue Chats verwenden OMP; Pi-Verlaufsimporte und entfernte Pi-Hosts entfallen.",
    "Automatische Erinnerungen reparieren und Projekt-, Worktree- und temporäre Bereiche erhalten.",
    "Abstände, Suche und schmale Fenster in den Erinnerungseinstellungen verbessern.",
    "Veröffentlichte Denkstufen und Bild-/PDF-Fähigkeiten erkennen und manuelle Werte behalten.",
    "HTML-Verweise im Dateimanager, integrierten Browser oder der Standardanwendung öffnen.",
    "Den Abschluss nach dauerhafter Speicherung des Durchlaufs melden."
  ],
  "es": [
    "Los chats nuevos usan OMP; se retiran la importación Pi y los hosts Pi remotos.",
    "Corrige la memoria automática y conserva los ámbitos de proyecto, worktree y chats temporales.",
    "Mejora el espaciado, la búsqueda y el diseño de ventanas estrechas en Memoria.",
    "Reconoce niveles de razonamiento y capacidades de imagen/PDF publicados y conserva los ajustes manuales.",
    "Abre referencias HTML en el gestor de archivos, navegador integrado o aplicación predeterminada.",
    "Notifica la finalización después de guardar el estado del turno."
  ],
  "fr": [
    "Les nouveaux échanges utilisent OMP ; les imports Pi et les hôtes Pi distants sont retirés.",
    "Corrige la mémoire automatique et préserve les domaines projet, worktree et échange temporaire.",
    "Améliore les espacements, la recherche et les réglages Mémoire en fenêtre étroite.",
    "Reconnaît les niveaux de réflexion et capacités image/PDF publiés en préservant les choix manuels.",
    "Ouvre les références HTML dans le gestionnaire de fichiers, le navigateur intégré ou l’application par défaut.",
    "Annonce la fin du tour après l’enregistrement durable de son état."
  ],
  "ko": [
    "새 대화는 OMP를 사용하며 Pi 기록 가져오기와 원격 Pi 호스트를 종료합니다.",
    "자동 메모리를 수정하고 프로젝트, worktree, 임시 대화 범위를 유지합니다.",
    "메모리 설정의 간격, 검색 및 좁은 창 레이아웃을 개선합니다.",
    "공개된 추론 단계와 이미지/PDF 기능을 인식하고 수동 설정을 유지합니다.",
    "HTML 참조를 파일 관리자, 내장 브라우저 또는 시스템 기본 앱으로 엽니다.",
    "턴 상태가 영구 저장된 후 완료를 알립니다."
  ],
  "tr": [
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
  { version: "0.1.8", date: "2026-11-11", highlights: unified018[locale] },
  { version: "0.1.7", date: "2026-11-09", highlights: unified017[locale] },
  { version: "0.1.6", date: "2026-10-24", highlights: unified016[locale] },
  { version: "0.1.5", date: "2026-10-23", highlights: unified015[locale] },
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
