import type { ChatModelChoice } from "../../shared/types";
import { HOSTED_COPY } from "../../shared/hostedCopy";
import React from "react";
export function ModelPicker({
  models,
  selected,
  onSelect,
  capReason,
}: {
  models: ChatModelChoice[];
  capReason?: string;
  selected: string;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="sospio-chat-start">
      <h2>Start a conversation</h2>
      <p>
        Choose the assistant’s model. It stays fixed for this conversation, so
        every reading and receipt refers to the same model.
      </p>
      <fieldset>
        <legend>Assistant model</legend>
        {models.map((model) => (
          <label
            key={model.name}
            className={selected === model.name ? "sospio-chat-chosen" : ""}
          >
            <input
              type="radio"
              name="sospio-model"
              disabled={model.provider === "openrouter" && !!capReason}
              checked={selected === model.name}
              onChange={() => onSelect(model.name)}
            />
            <span>
              <strong>{model.label ?? model.name}</strong>
              {model.provider === "openrouter" && <small>{model.name}</small>}
              <small>{model.provider === "openrouter" ? HOSTED_COPY.disclosure(model.vendor ?? "the vendor") : HOSTED_COPY.local}</small>
              {model.provider === "openrouter" && capReason && <small>{capReason}</small>}
            </span>
          </label>
        ))}
      </fieldset>
      <p>
        This chat may be monitored or recorded for quality assurance or testing
        purposes.
      </p>
    </div>
  );
}
