import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { IconCheck, IconChevronDown } from "./icons";
import "../styles/todo-dock.css";

/** The native runtime owns the list; the dock only reveals its current state. */
export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const phases = useAppStore((state) => state.sessionTodos[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const tasks = phases?.flatMap((phase) => phase.tasks) ?? [];
  if (!tasks.length) return null;
  const current = tasks.find((task) => task.status === "in_progress") ?? tasks.find((task) => task.status === "blocked");
  const total = tasks.filter((task) => task.status !== "abandoned").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return (
    <section className="todo-dock" aria-label={t("chat.todo.title")} data-session-todos={sessionId}>
      <button type="button" className="todo-dock-toggle" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}>
        <span>{t("chat.todo.progress", { completed, total })}</span>
        {current ? <span className="todo-dock-current" title={current.content}>{current.content}</span> : null}
        <IconChevronDown size={14} className={expanded ? "is-expanded" : ""} aria-hidden />
        <span className="sr-only">{t(expanded ? "chat.todo.collapse" : "chat.todo.expand")}</span>
      </button>
      {expanded ? (
        <div id={contentId} className="todo-dock-list" tabIndex={0}>
          {phases?.map((phase, phaseIndex) => (
            <div key={phaseIndex}>
              {phase.name ? <div className="todo-dock-phase">{phase.name}</div> : null}
              <ul>
                {phase.tasks.map((task, index) => (
                  <li key={index} className={`todo-dock-row todo-${task.status}`}>
                    <span className="todo-dock-symbol" role="img" aria-label={t(`chat.todo.status.${task.status}`)}>
                      {task.status === "completed" ? <IconCheck size={13} aria-hidden /> : task.status === "in_progress" ? "◐" : task.status === "blocked" ? "!" : task.status === "abandoned" ? "−" : "○"}
                    </span>
                    <span>{task.content}{task.blocker ? <small className="todo-dock-blocker">{task.blocker}</small> : null}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
