import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
} from "discord.js";

import { divisionLabel } from "../../constants.js";
import { config } from "../../config.js";
import {
  interactionOutcome,
  renderInteractionPanel,
} from "../../messages/index.js";

const MAX_CUSTOM_ID_LENGTH = 100;
const MAX_NATIVE_SELECTIONS = 25;
const CONTAINER_COLORS = Object.freeze({
  BRAND: 0x5865f2,
  SUCCESS: 0x57f287,
  DANGER: 0xed4245,
});

export const PROJECT_SETUP_ACTIONS = Object.freeze({
  NAME_OPEN: "no",
  NAME_MODAL: "nm",
  UNIVERSITY: "uni",
  DIVISION: "div",
  UNIVERSITY_PREVIOUS: "up",
  UNIVERSITY_NEXT: "un",
  UNIVERSITY_CONTINUE: "uc",
  DIVISION_PREVIOUS: "dp",
  DIVISION_NEXT: "dn",
  SCOPE_DONE: "sd",
  MEMBERS: "mem",
  SUPERVISORS: "sup",
  PEOPLE_DONE: "pd",
  DATES_OPEN: "do",
  DATES_MODAL: "dm",
  NOTES_OPEN: "nto",
  NOTES_MODAL: "ntm",
  REVIEW: "rev",
  BACK_SCOPE: "bs",
  BACK_PEOPLE: "bp",
  BACK_DETAILS: "bd",
  CREATE: "crt",
  CANCEL: "can",
});

const ACTION_VALUES = new Set<string>(Object.values(PROJECT_SETUP_ACTIONS));

export function projectSetupId(sessionId, action) {
  const customId = ["pc", sessionId, action].join(":");
  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`Project setup custom id is too long: ${customId.length}`);
  }
  return customId;
}

export function parseProjectSetupId(customId) {
  const [prefix, sessionId, action, ...extra] = String(customId ?? "").split(
    ":",
  );
  if (
    prefix !== "pc" ||
    !sessionId ||
    !ACTION_VALUES.has(action) ||
    extra.length > 0
  )
    return null;
  return { sessionId, action };
}

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function separator(spacing = SeparatorSpacingSize.Large) {
  return new SeparatorBuilder().setDivider(true).setSpacing(spacing);
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function timelineSummary(session) {
  return session.startDate && session.expectedEnd
    ? `${session.startDate} → ${session.expectedEnd}`
    : "Not set yet";
}

function teamSummary(session) {
  if (session.memberIds.length === 0 && session.supervisorIds.length === 0)
    return "Not selected yet";
  return `${countLabel(session.memberIds.length, "member")} · ${countLabel(session.supervisorIds.length, "supervisor")}`;
}

function projectSummary(session) {
  return text(
    [
      `## ${escapeMarkdown(session.name || "New project")}`,
      "",
      "**Project summary**",
      "",
      `**Scope** · ${selectedScope(session)}`,
      "",
      `**Team** · ${teamSummary(session)}`,
      "",
      `**Timeline** · ${timelineSummary(session)}`,
      "",
      `**Public summary** · ${session.summary ? "Added" : "Required"}`,
      `**Internal notes** · ${session.notes ? "Added" : "Not added"}`,
    ].join("\n"),
  );
}

function sectionHeading(title) {
  return text(`### ${title}`);
}

function fieldLabel(label) {
  return text(`**${label}**`);
}

function actionButton(
  session,
  action,
  label,
  style = ButtonStyle.Secondary,
  options: { disabled?: boolean } = {},
) {
  const button = new ButtonBuilder()
    .setCustomId(projectSetupId(session.id, action))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(Boolean(options.disabled));
  return button;
}

function navigationRow(session, next, back) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    actionButton(session, next.action, next.label, ButtonStyle.Primary, {
      disabled: next.disabled,
    }),
    actionButton(session, back.action, back.label),
    actionButton(
      session,
      PROJECT_SETUP_ACTIONS.CANCEL,
      "Cancel setup",
      ButtonStyle.Danger,
    ),
  );
}

function wizardPayload(container) {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function formatPeople(ids) {
  return ids.length > 0
    ? ids.map((id) => `<@${id}>`).join(", ")
    : "Not selected yet";
}

function selectedScope(session) {
  if (!session.university) return "Not selected yet";
  return session.division
    ? `${session.university} · ${divisionLabel(session.division, session.divisionColor)}`
    : `${session.university} · Choose a division`;
}

function universityMenu(session) {
  const pageStart = session.universityPage * MAX_NATIVE_SELECTIONS;
  const universities = session.universities.slice(pageStart, pageStart + MAX_NATIVE_SELECTIONS);
  return new StringSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.UNIVERSITY))
    .setPlaceholder("Choose the owning university")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      universities.map((university, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(university.name.slice(0, 100))
          .setValue(String(pageStart + index))
          .setDefault(university.name === session.university),
      ),
    );
}

function divisionMenu(session) {
  if (!session.university) {
    return new StringSelectMenuBuilder()
      .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.DIVISION))
      .setPlaceholder("Choose a university first")
      .setDisabled(true)
      .addOptions({ label: "University required", value: "pending" });
  }

  const pageStart = session.divisionPage * MAX_NATIVE_SELECTIONS;
  const divisions = session.divisions.slice(pageStart, pageStart + MAX_NATIVE_SELECTIONS);
  return new StringSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.DIVISION))
    .setPlaceholder("Choose the project division")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      divisions.map((division, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(divisionLabel(division.name, division.color).slice(0, 100))
          .setValue(String(pageStart + index))
          .setDefault(division.name === session.division),
      ),
    );
}

function paginationRow(session, previousAction, nextAction, page, itemCount, itemLabel) {
  const pageCount = Math.ceil(itemCount / MAX_NATIVE_SELECTIONS);
  if (pageCount <= 1) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    actionButton(session, previousAction, `Previous ${itemLabel}`, ButtonStyle.Secondary, {
      disabled: page <= 0,
    }),
    actionButton(session, nextAction, `Next ${itemLabel}`, ButtonStyle.Secondary, {
      disabled: page >= pageCount - 1,
    }),
  );
}

function userMenu(session, action, placeholder, selectedIds) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, action))
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(MAX_NATIVE_SELECTIONS);
  if (selectedIds.length > 0) menu.setDefaultUsers(selectedIds);
  return menu;
}

export function projectNameModal(session) {
  const input = new TextInputBuilder()
    .setCustomId("project_name")
    .setLabel("Project name")
    .setPlaceholder("e.g. Market Intelligence Sprint")
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(80);
  if (session.name) input.setValue(session.name);

  return new ModalBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.NAME_MODAL))
    .setTitle("Project setup · Name")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
}

export function projectDatesModal(session) {
  const start = new TextInputBuilder()
    .setCustomId("start_date")
    .setLabel("Start date")
    .setPlaceholder("YYYY-MM-DD")
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMinLength(10)
    .setMaxLength(10);
  const end = new TextInputBuilder()
    .setCustomId("expected_end")
    .setLabel("Expected end date")
    .setPlaceholder("YYYY-MM-DD")
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMinLength(10)
    .setMaxLength(10);
  if (session.startDate) start.setValue(session.startDate);
  if (session.expectedEnd) end.setValue(session.expectedEnd);

  return new ModalBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.DATES_MODAL))
    .setTitle("Project setup · Timeline")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(start),
      new ActionRowBuilder<TextInputBuilder>().addComponents(end),
    );
}

export function projectNotesModal(session) {
  const summary = new TextInputBuilder()
    .setCustomId("summary")
    .setLabel("Public project summary")
    .setPlaceholder("What is this project doing, and why does it matter?")
    .setRequired(true)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1_000);
  const notes = new TextInputBuilder()
    .setCustomId("notes")
    .setLabel("Internal working notes")
    .setPlaceholder("Optional private context for the project team")
    .setRequired(false)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1_000);
  if (session.summary) summary.setValue(session.summary);
  if (session.notes) notes.setValue(session.notes);

  return new ModalBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.NOTES_MODAL))
    .setTitle("Project setup · Summary")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(summary),
      new ActionRowBuilder<TextInputBuilder>().addComponents(notes),
    );
}

export function scopePayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(CONTAINER_COLORS.BRAND)
    .addTextDisplayComponents(projectSummary(session))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text("### Choose the project scope"));

  if (!session.universityConfirmed) {
    container.addTextDisplayComponents(fieldLabel("University"))
      .addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(universityMenu(session)),
      );
    const universityPagination = paginationRow(
      session,
      PROJECT_SETUP_ACTIONS.UNIVERSITY_PREVIOUS,
      PROJECT_SETUP_ACTIONS.UNIVERSITY_NEXT,
      session.universityPage,
      session.universities.length,
      "universities",
    );
    if (universityPagination) container.addActionRowComponents(universityPagination);
    container.addSeparatorComponents(separator())
      .addActionRowComponents(
        navigationRow(
          session,
          {
            action: PROJECT_SETUP_ACTIONS.UNIVERSITY_CONTINUE,
            label: "Continue to division",
            disabled: !session.university,
          },
          { action: PROJECT_SETUP_ACTIONS.NAME_OPEN, label: "Back to name" },
        ),
      );
    return wizardPayload(container);
  }

  container.addTextDisplayComponents(
    text(`**University**\n\n${escapeMarkdown(session.university)}${session.fixedUniversity ? " · From this bot-log" : ""}`),
    fieldLabel("Division"),
  )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        divisionMenu(session),
      ),
    );
  const divisionPagination = paginationRow(
    session,
    PROJECT_SETUP_ACTIONS.DIVISION_PREVIOUS,
    PROJECT_SETUP_ACTIONS.DIVISION_NEXT,
    session.divisionPage,
    session.divisions.length,
    "divisions",
  );
  if (divisionPagination) container.addActionRowComponents(divisionPagination);
  container.addSeparatorComponents(separator())
    .addActionRowComponents(
      navigationRow(
        session,
        {
          action: PROJECT_SETUP_ACTIONS.SCOPE_DONE,
          label: "Continue to team",
          disabled: !session.division,
        },
        { action: PROJECT_SETUP_ACTIONS.NAME_OPEN, label: "Back to name" },
      ),
    );

  return wizardPayload(container);
}

export function participantsPayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(CONTAINER_COLORS.BRAND)
    .addTextDisplayComponents(projectSummary(session))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(
      sectionHeading("Choose the project team"),
      fieldLabel("Members"),
    )
    .addActionRowComponents(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        userMenu(
          session,
          PROJECT_SETUP_ACTIONS.MEMBERS,
          "Select project members",
          session.memberIds,
        ),
      ),
    )
    .addTextDisplayComponents(fieldLabel("Supervisors"))
    .addActionRowComponents(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        userMenu(
          session,
          PROJECT_SETUP_ACTIONS.SUPERVISORS,
          "Select project supervisors",
          session.supervisorIds,
        ),
      ),
    )
    .addSeparatorComponents(separator())
    .addActionRowComponents(
      navigationRow(
        session,
        {
          action: PROJECT_SETUP_ACTIONS.PEOPLE_DONE,
          label: "Continue to details",
          disabled:
            session.memberIds.length === 0 ||
            session.supervisorIds.length === 0,
        },
        { action: PROJECT_SETUP_ACTIONS.BACK_SCOPE, label: "Back to scope" },
      ),
    );

  return wizardPayload(container);
}

export function detailsPayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(CONTAINER_COLORS.BRAND)
    .addTextDisplayComponents(projectSummary(session))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(
      sectionHeading("Set the project details"),
      fieldLabel("Project timeline"),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(
          session,
          PROJECT_SETUP_ACTIONS.DATES_OPEN,
          session.startDate ? "Edit project timeline" : "Set project timeline",
          ButtonStyle.Primary,
        ),
      ),
    )
    .addTextDisplayComponents(fieldLabel("Summary and internal notes"))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(
          session,
          PROJECT_SETUP_ACTIONS.NOTES_OPEN,
          session.summary ? "Edit summary and notes" : "Add public summary",
          ButtonStyle.Primary,
        ),
      ),
    )
    .addSeparatorComponents(separator())
    .addActionRowComponents(
      navigationRow(
        session,
        {
          action: PROJECT_SETUP_ACTIONS.REVIEW,
          label: "Continue to review",
          disabled: !session.startDate || !session.expectedEnd || !session.summary,
        },
        { action: PROJECT_SETUP_ACTIONS.BACK_PEOPLE, label: "Back to team" },
      ),
    );

  return wizardPayload(container);
}

export function reviewPayload(session) {
  const review = [
    `## Review the project · ${escapeMarkdown(session.name || "New project")}`,
    `**Scope**\n${selectedScope(session)}`,
    `**Timeline**\n${timelineSummary(session)}`,
    `**Members · ${session.memberIds.length}**\n${formatPeople(session.memberIds)}`,
    `**Supervisors · ${session.supervisorIds.length}**\n${formatPeople(session.supervisorIds)}`,
    "**Division oversight**\nThe selected division's active Head(s) will automatically be included in the project channel as supervisors.",
    `**Public summary**\n${session.summary?.slice(0, 1_000) || "Missing"}`,
    `**Internal notes**\n${session.notes?.slice(0, 1_000) || "None"}`,
  ].join("\n\n");
  const container = new ContainerBuilder()
    .setAccentColor(CONTAINER_COLORS.BRAND)
    .addTextDisplayComponents(text(review))
    .addSeparatorComponents(separator())
    .addActionRowComponents(
      navigationRow(
        session,
        { action: PROJECT_SETUP_ACTIONS.CREATE, label: "Create project" },
        {
          action: PROJECT_SETUP_ACTIONS.BACK_DETAILS,
          label: "Back to details",
        },
      ),
    );

  return wizardPayload(container);
}

export function cancelledPayload() {
  return renderInteractionPanel(interactionOutcome({
    outcome: "cancelled",
    title: "Project setup cancelled",
    description: "Nothing was created.",
  }));
}

export function createdPayload(acknowledgement) {
  return renderInteractionPanel(interactionOutcome({
    outcome: acknowledgement.includes("pending") ? "reconciliation-pending" : "success",
    title: "Project created",
    description: acknowledgement,
  }));
}

export function creatingPayload(session) {
  return renderInteractionPanel({
    kind: "interaction-panel",
    tone: "pending",
    title: `Creating ${escapeMarkdown(session.name || "project")}`,
    description: `${config.botName} is checking eligibility, saving the project, and preparing its private Discord channel.`,
    status: "This message will update when the project is ready. Do not submit it again.",
    audience: "actor",
  });
}

export function creationFailedPayload(session, message) {
  return renderInteractionPanel({
    kind: "interaction-panel",
    tone: "danger",
    title: "Project not created",
    description: "Nothing was saved. Your project setup is still available.",
    facts: [
      { label: "Project", value: session.name || "New project" },
      { label: "Scope", value: selectedScope(session) },
      { label: "Team", value: teamSummary(session) },
      { label: "Timeline", value: timelineSummary(session) },
    ],
    sections: [{ heading: "What happened", body: escapeMarkdown(message) }],
    actions: [
      {
        id: projectSetupId(session.id, PROJECT_SETUP_ACTIONS.CREATE),
        label: "Try creating project",
        style: "primary",
      },
      {
        id: projectSetupId(session.id, PROJECT_SETUP_ACTIONS.BACK_DETAILS),
        label: "Back to details",
        style: "secondary",
      },
      {
        id: projectSetupId(session.id, PROJECT_SETUP_ACTIONS.CANCEL),
        label: "Cancel setup",
        style: "danger",
      },
    ],
    audience: "actor",
  });
}

export { MAX_NATIVE_SELECTIONS as PROJECT_SETUP_SELECTION_LIMIT };
