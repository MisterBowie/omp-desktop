/**
 * Example plugin entry used by local dev load and marketplace packaging samples
 * Host injects global `pi`.
 */

/** Interval owned by the resident service; cleared when the host stops it. */
let heartbeat;
/** Returned by `pi.bus.subscribe`; called on unload to drop the route. */
let unsubscribe;

async function onLoad() {
 const settings = await pi.plugin.getSettings();

 await pi.commands.register({
 id: "hello.open",
 title: "Hello: Open Panel",
 keywords: ["hello", "demo"],
 run: async () => {
 await pi.ui.openPanel({ title: "Hello Plugin" });
 await pi.ui.showToast(settings.greeting || "Hello from plugin");
 // Declared in `contributes.bus.publish`; other plugins may listen.
 await pi.bus.publish("demo.hello.greeted", { greeting: settings.greeting });
 },
 });

 await pi.agent.registerTool({
 name: "echo_text",
 description: "Echo text back to the agent",
 risk: "low",
 schema: {
 type: "object",
 properties: {
 text: { type: "string" },
 },
 required: ["text"],
 },
 execute: async (args) => {
 const text = String(args?.text ?? "");
 return {
 ok: true,
 echo: text,
 pluginId: pi.plugin.getId(),
 };
 },
 });

 // A publisher never receives its own messages, so this only fires for
 // `demo.*` traffic from another plugin.
 unsubscribe = await pi.bus.subscribe("demo.**", async (message) => {
 await pi.ui.showToast(`bus: ${message.topic} from ${message.from}`);
 });

 // Resident service declared in `contributes.services`. The host starts it
 // after onLoad and restarts it with backoff if this process dies.
 pi.services.register({
 id: "greeter",
 start: ({ log }) => {
 log("greeter heartbeat started");
 heartbeat = setInterval(() => {
 void pi.bus.publish("demo.hello.tick", { at: new Date().toISOString() });
 }, 60_000);
 },
 stop: () => {
 clearInterval(heartbeat);
 heartbeat = undefined;
 },
 });
}

async function onUnload() {
 clearInterval(heartbeat);
 heartbeat = undefined;
 if (unsubscribe) {
 await unsubscribe();
 unsubscribe = undefined;
 }
 await pi.commands.unregister("hello.open");
 await pi.agent.unregisterTool("echo_text");
}

module.exports = {
 onLoad,
 onUnload,
};
