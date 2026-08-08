import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  escapeMarkdown,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from "discord.js";

import { divisionLabel, MEMBER_TYPES } from "../constants.js";
import { onboardingId, ONBOARDING_ACTIONS } from "./custom-ids.js";
import { pageItems } from "./state.js";

const EMBED_COLORS = Object.freeze({
  BRAND: 0x5865f2,
  PENDING: 0xf0b429,
  SUCCESS: 0x57f287,
  DANGER: 0xed4245,
});

export function onboardingStartPayload() {
  return {
    content:
      "Welcome to BAINSA. Begin your membership application here; the relevant university board will review your request.",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("onboarding:start")
          .setEmoji("🚀")
          .setLabel("Begin onboarding")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

export function memberTypePayload(requestId) {
  return {
    embeds: [
      onboardingEmbed("Step 2 of 4 · Choose your path")
        .setDescription(
          "Select the description that best reflects how you will participate in BAINSA.",
        )
        .addFields(
          {
            name: "🔬 Researcher",
            value:
              "An active BAINSA member currently enrolled at one university.",
          },
          {
            name: "🎓 Alumni",
            value: "A former BAINSA member who remains part of the community.",
          },
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(
            onboardingId(
              ONBOARDING_ACTIONS.MEMBER_TYPE,
              requestId,
              MEMBER_TYPES.RESEARCHER,
            ),
          )
          .setEmoji("🔬")
          .setLabel("Researcher")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(
            onboardingId(
              ONBOARDING_ACTIONS.MEMBER_TYPE,
              requestId,
              MEMBER_TYPES.ALUMNI,
            ),
          )
          .setEmoji("🎓")
          .setLabel("Alumni")
          .setStyle(ButtonStyle.Primary),
        cancelButton(requestId),
      ),
    ],
  };
}

export function universityPayload(
  requestId,
  universities,
  page = 0,
  selectedUniversityId = null,
) {
  const slice = pageItems(universities, page);
  const selectedId = selectedUniversityId == null ? null : String(selectedUniversityId);
  const selectedUniversity = universities.find((university) => String(university.id) === selectedId);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      onboardingId(ONBOARDING_ACTIONS.UNIVERSITY, requestId, slice.page),
    )
    .setPlaceholder("Choose your university")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      slice.items.map((university) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(university.name)
          .setValue(String(university.id))
          .setDefault(String(university.id) === selectedId),
      ),
    );

  return {
    embeds: [
      onboardingEmbed("Step 3 of 4 · Choose your university")
        .setDescription(
          selectedUniversity
            ? `**Selected:** ${selectedUniversity.name}\n\nConfirm this choice to continue.`
            : "Select the university you currently belong to, or the one you were part of as an Alumni.",
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(menu),
      paginationRow(
        onboardingId(
          ONBOARDING_ACTIONS.UNIVERSITY_PAGE,
          requestId,
          slice.page - 1,
        ),
        onboardingId(
          ONBOARDING_ACTIONS.UNIVERSITY_PAGE,
          requestId,
          slice.page + 1,
        ),
        slice,
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(onboardingId(ONBOARDING_ACTIONS.UNIVERSITY_DONE, requestId))
          .setLabel("Confirm university")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!selectedUniversity),
        cancelButton(requestId),
      ),
    ].filter(Boolean),
  };
}

export function divisionPayload(
  requestId,
  divisions,
  selectedIds = [],
  page = 0,
) {
  const selected = new Set((selectedIds ?? []).map(String));
  const slice = pageItems(divisions, page);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      onboardingId(ONBOARDING_ACTIONS.DIVISIONS, requestId, slice.page),
    )
    .setPlaceholder("Choose your division")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      slice.items.map((division) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(divisionLabel(division.name, division.color).slice(0, 100))
          .setValue(String(division.id))
          .setDefault(selected.has(String(division.id))),
      ),
    );

  return {
    embeds: [
      onboardingEmbed("Step 4 of 4 · Choose your division")
        .setDescription(
          "Choose the one division where you will contribute. You can update this later through the university board if your role changes.",
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(menu),
      paginationRow(
        onboardingId(
          ONBOARDING_ACTIONS.DIVISIONS_PAGE,
          requestId,
          slice.page - 1,
        ),
        onboardingId(
          ONBOARDING_ACTIONS.DIVISIONS_PAGE,
          requestId,
          slice.page + 1,
        ),
        slice,
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(
            onboardingId(ONBOARDING_ACTIONS.DIVISIONS_DONE, requestId),
          )
          .setLabel("Continue")
          .setStyle(ButtonStyle.Primary),
        cancelButton(requestId),
      ),
    ].filter(Boolean),
  };
}

export function confirmPayload(requestId, draft, university, divisions) {
  const divisionNames =
    divisions.length > 0
      ? divisions
          .map((division) => divisionLabel(division.name, division.color))
          .join(", ")
      : "None";
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(EMBED_COLORS.BRAND)
        .addTextDisplayComponents(
          textDisplay(
            [
              "## Review your application",
              "Please check these details before sending your request to the university board.",
              "",
              "**Applicant**",
              escapeMarkdown(draft.full_name ?? "Not provided"),
              "",
              "**Path**",
              memberTypeLabel(draft.member_type),
              "",
              "**University**",
              escapeMarkdown(university.name),
              "",
              "**Division**",
              escapeMarkdown(divisionNames),
            ].join("\n"),
          ),
        )
        .addSeparatorComponents(separator())
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(onboardingId(ONBOARDING_ACTIONS.SUBMIT, requestId))
              .setEmoji("📨")
              .setLabel("Submit application")
              .setStyle(ButtonStyle.Success),
            cancelButton(requestId),
          ),
        ),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

export function reviewPayload(request, university, divisions) {
  const divisionNames =
    divisions.length > 0
      ? divisions
          .map((division) => divisionLabel(division.name, division.color))
          .join(", ")
      : "None";
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLORS.PENDING)
        .setAuthor({ name: "BAINSA · Onboarding review" })
        .setTitle("New access request")
        .setDescription(
          `**<@${request.discord_user_id}>** is waiting for a review.`,
        )
        .addFields(
          {
            name: "Applicant",
            value: request.full_name ?? "Not provided",
            inline: true,
          },
          {
            name: "Path",
            value: memberTypeLabel(request.member_type),
            inline: true,
          },
          { name: "University", value: university.name, inline: true },
          { name: "Division", value: divisionNames, inline: true },
          ...(request.previously_removed
            ? [{
              name: "Member history",
              value: "⚠️ Previously removed from the server; this is a reapplication.",
              inline: false,
            }]
            : []),
          { name: "Review status", value: "🟡 Pending review", inline: true },
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(onboardingId(ONBOARDING_ACTIONS.APPROVE, request.id))
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(onboardingId(ONBOARDING_ACTIONS.REJECT, request.id))
          .setLabel("Reject")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

export function reviewedPayload(
  request,
  university,
  divisions,
  reviewerId,
  reason = null,
) {
  const base = reviewPayload(request, university, divisions);
  const isApproved = request.status === "approved";
  const embed = EmbedBuilder.from(base.embeds[0])
    .setColor(isApproved ? EMBED_COLORS.SUCCESS : EMBED_COLORS.DANGER)
    .setTitle(
      isApproved ? "Access request approved" : "Access request declined",
    )
    .setDescription(
      `**<@${request.discord_user_id}>** has been ${isApproved ? "approved" : "declined"}.`,
    )
    .setFields(
      ...base.embeds[0].data.fields.filter(
        (field) => field.name !== "Review status",
      ),
      {
        name: "Review status",
        value: isApproved ? "🟢 Approved" : "🔴 Declined",
        inline: true,
      },
      { name: "Reviewed by", value: `<@${reviewerId}>`, inline: true },
    );

  if (reason) embed.addFields({ name: "Reason", value: reason });

  return { embeds: [embed], components: [] };
}

function onboardingEmbed(title) {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.BRAND)
    .setAuthor({ name: "BAINSA · Membership application" })
    .setTitle(title);
}

function textDisplay(content) {
  return new TextDisplayBuilder().setContent(content);
}

function separator() {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Large);
}

function memberTypeLabel(memberType) {
  return memberType === MEMBER_TYPES.ALUMNI ? "🎓 Alumni" : "🔬 Researcher";
}

function cancelButton(requestId) {
  return new ButtonBuilder()
    .setCustomId(onboardingId(ONBOARDING_ACTIONS.CANCEL, requestId))
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);
}

function paginationRow(previousId, nextId, slice) {
  if (!slice.hasPrevious && !slice.hasNext) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(previousId)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!slice.hasPrevious),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!slice.hasNext),
  );
}
