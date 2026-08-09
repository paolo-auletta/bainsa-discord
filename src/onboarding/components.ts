import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

import { divisionLabel, MEMBER_TYPES } from "../constants.js";
import { PROFILE_CUSTOM_IDS } from "../profiles/custom-ids.js";
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
      "Welcome to BAINSA. Begin your membership application here; the relevant university board will review your request. Already applied? Check your application status below.",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("onboarding:start")
          .setEmoji("🚀")
          .setLabel("Begin onboarding")
          .setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("onboarding:status")
          .setEmoji("🔎")
          .setLabel("Check application status")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export function memberTypePayload(requestId, selectedMemberType = null) {
  const pathMenu = new StringSelectMenuBuilder()
    .setCustomId(onboardingId(ONBOARDING_ACTIONS.MEMBER_TYPE, requestId))
    .setPlaceholder("Choose your path")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Researcher")
        .setValue(MEMBER_TYPES.RESEARCHER)
        .setEmoji("🔬")
        .setDefault(selectedMemberType === MEMBER_TYPES.RESEARCHER),
      new StringSelectMenuOptionBuilder()
        .setLabel("Alumni")
        .setValue(MEMBER_TYPES.ALUMNI)
        .setEmoji("🎓")
        .setDefault(selectedMemberType === MEMBER_TYPES.ALUMNI),
    );
  return {
    embeds: [
      onboardingEmbed("Step 2 of 4 · Choose your path")
        .setDescription([
          "Choose the path that best reflects how you will participate in BAINSA.",
          "",
          "🔬 **Researcher** — An active BAINSA member currently enrolled at one university.",
          "🎓 **Alumni** — A former BAINSA member who remains part of the community.",
        ].join("\n")),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pathMenu),
      footerRow(
        requestId,
        {
          action: ONBOARDING_ACTIONS.MEMBER_TYPE_DONE,
          label: "Continue to university",
          disabled: !selectedMemberType,
        },
        { action: ONBOARDING_ACTIONS.BACK_NAME, label: "Back to name" },
      ),
    ],
  };
}

export function universityPayload(
  requestId,
  universities,
  page = 0,
  selectedUniversityId = null,
  memberType = null,
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
        .setDescription("Select the university you currently belong to, or the one you were part of as an Alumni."),
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
        ...footerButtons(
          requestId,
          {
            action: ONBOARDING_ACTIONS.UNIVERSITY_DONE,
            label: memberType === MEMBER_TYPES.ALUMNI ? "Continue to review" : "Continue to division",
            disabled: !selectedUniversity,
          },
          { action: ONBOARDING_ACTIONS.BACK_MEMBER_TYPE, label: "Back to path" },
        ),
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
        ...footerButtons(
          requestId,
          { action: ONBOARDING_ACTIONS.DIVISIONS_DONE, label: "Continue to review" },
          { action: ONBOARDING_ACTIONS.BACK_UNIVERSITY, label: "Back to university" },
        ),
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
    embeds: [
      onboardingEmbed("Review your application").setDescription(
        [
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
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...footerButtons(
          requestId,
          { action: ONBOARDING_ACTIONS.SUBMIT, label: "Submit application", style: ButtonStyle.Success, emoji: "📨" },
          {
            action: draft.member_type === MEMBER_TYPES.RESEARCHER
              ? ONBOARDING_ACTIONS.BACK_DIVISIONS
              : ONBOARDING_ACTIONS.BACK_UNIVERSITY,
            label: draft.member_type === MEMBER_TYPES.RESEARCHER ? "Back to division" : "Back to university",
          },
        ),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export function onboardingSubmittingPayload() {
  return {
    embeds: [
      onboardingEmbed("Submitting your application")
        .setColor(EMBED_COLORS.PENDING)
        .setDescription(
          "Please wait while BAINSA sends your application to the correct university board. This message will update when the request is safely recorded.",
        ),
    ],
    components: [],
  };
}

export function onboardingSubmissionFailedPayload(requestId, draft, university, divisions, message) {
  const base = confirmPayload(requestId, draft, university, divisions);
  const embed = EmbedBuilder.from(base.embeds[0])
    .setColor(EMBED_COLORS.DANGER)
    .setTitle("Application not submitted")
    .setDescription(
      [
        "Nothing was sent to the university board. Your application details are still available below.",
        "",
        `**What happened**\n${escapeMarkdown(message)}`,
        "",
        base.embeds[0].data.description,
      ].join("\n"),
    );
  return { ...base, embeds: [embed] };
}

export function reviewDecisionProgressPayload(decision) {
  const approving = decision === "approve";
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLORS.PENDING)
        .setAuthor({ name: "BAINSA · Onboarding review" })
        .setTitle(approving ? "Approving access" : "Declining application")
        .setDescription(
          approving
            ? "Please wait while the member record, nickname, and Discord access are updated."
            : "Please wait while the decision is recorded and the applicant notification is prepared.",
        ),
    ],
    components: [],
    allowedMentions: { parse: [] },
  };
}

export function reviewDecisionFailedPayload(request, university, divisions, decision, message) {
  const approving = decision === "approve";
  const base = request && university ? reviewPayload(request, university, divisions) : null;
  const embed = base
    ? EmbedBuilder.from(base.embeds[0])
    : new EmbedBuilder().setAuthor({ name: "BAINSA · Onboarding review" });

  embed
    .setColor(EMBED_COLORS.DANGER)
    .setTitle(approving ? "Approval could not be completed" : "Decline could not be completed")
    .setDescription([
      approving
        ? "No approval was recorded and the applicant's access was not changed."
        : "No decline was recorded and the application is still awaiting review.",
      escapeMarkdown(message),
      base ? "You can try the decision again." : null,
    ].filter(Boolean).join("\n\n"));

  if (base) {
    embed.setFields(
      ...base.embeds[0].data.fields.filter((field) => field.name !== "Review status"),
      { name: "Review status", value: "⚠️ Decision not completed", inline: true },
    );
  }

  return {
    embeds: [embed],
    components: base?.components ?? [],
    allowedMentions: { parse: [] },
  };
}

export function noApplicationStatusPayload() {
  return {
    embeds: [
      onboardingEmbed("No application yet")
        .setDescription("Begin onboarding when you are ready. The private application usually takes only a few minutes."),
    ],
    components: [startApplicationRow("Begin onboarding")],
  };
}

export function applicationStatusPayload({ request, university, divisions, links = [], submitted = false }) {
  const status = request.status;
  const details = applicationDetails(request, university, divisions);
  const reason = request.review_reason?.trim();
  let title;
  let color: number = EMBED_COLORS.BRAND;
  let description;
  let components = [];

  if (status === "draft") {
    title = "Application in progress";
    description = "This application has not been sent to the university board yet. Continue when you are ready.";
    components = [startApplicationRow("Continue application")];
  } else if (status === "pending") {
    title = submitted ? "Application sent" : "Application pending review";
    color = EMBED_COLORS.PENDING;
    description = [
      "Your university board has received the application.",
      "BAINSA will try to send the decision by DM. You can also return to #onboarding and use **Check application status** at any time.",
    ].join("\n\n");
  } else if (status === "approved") {
    title = "Application approved";
    color = EMBED_COLORS.SUCCESS;
    description = [
      "Your BAINSA access is active.",
      links.length > 0 ? `**Start here**\n${links.map((line) => `• ${line}`).join("\n")}` : "Open the newly available Global BAINSA and university spaces to get started.",
      "The people database is optional and can be set up later from its **Start here** post.",
    ].join("\n\n");
  } else if (status === "rejected") {
    title = "Application declined";
    color = EMBED_COLORS.DANGER;
    description = [
      "Your access was not approved from this application.",
      `**Reason shared by the reviewer**\n${escapeMarkdown(reason || "No reason was provided.")}`,
      "Correct the relevant details, then start a new application when you are ready.",
    ].join("\n\n");
    components = [startApplicationRow("Start a new application")];
  } else {
    title = "Application cancelled";
    description = "Nothing was submitted. You can begin a new application whenever you are ready.";
    components = [startApplicationRow("Begin onboarding")];
  }

  return {
    embeds: [
      onboardingEmbed(title)
        .setColor(color)
        .setDescription(description)
        .addFields(...details),
    ],
    components,
    allowedMentions: { parse: [] },
  };
}

/** A persistent, role-aware guide reached from the shared #welcome message. */
export function memberSpacesPayload({
  university,
  divisions = [],
  channels = {},
  profilePublished = false,
}) {
  const universityName = escapeMarkdown(university?.name ?? "your university");
  const channel = (key, fallback) => channels[key] ? `<#${channels[key].id}>` : fallback;
  const division = divisions[0];
  const fields = [
    {
      name: "Global BAINSA",
      value: `${channel("globalGeneral", "#bainsa-general")}\nCross-university discussion.`,
      inline: true,
    },
    {
      name: universityName,
      value: `${channel("universityGeneral", "#general")}\nLocal coordination and updates.`,
      inline: true,
    },
    ...(division ? [{
      name: "Your division",
      value: `${channel("division", "your division room")}\nFocused work with your team.`,
      inline: true,
    }] : []),
    {
      name: "Resources",
      value: `${channel("resources", "#resources")}\nPapers, tools, datasets, and templates.`,
      inline: true,
    },
    {
      name: "Projects showcase",
      value: `${channel("projectShowcase", "#projects-showcase")}\nBrowse work; active projects stay private.`,
      inline: true,
    },
    {
      name: "People database",
      value: `${channel("peopleDatabase", "#people-database")}\nFind collaborators by work and interests.`,
      inline: true,
    },
    ...(!profilePublished ? [{
      name: "Make yourself findable",
      value: `Create a profile in ${channel("peopleDatabase", "#people-database")} so members can find you for research, projects, and collaboration.`,
      inline: false,
    }] : []),
  ];

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLORS.BRAND)
        .setAuthor({ name: "BAINSA" })
        .setTitle("Find your place in BAINSA")
        .setDescription("Your map to the community. Keep conversations in the narrowest useful space.")
        .addFields(...fields),
    ],
    components: profilePublished
      ? []
      : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(PROFILE_CUSTOM_IDS.START)
            .setLabel("Create my profile")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
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
    allowedMentions: { parse: [] },
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

  if (reason) embed.addFields({ name: "Reason", value: escapeMarkdown(reason) });

  return { embeds: [embed], components: [], allowedMentions: { parse: [] } };
}

function onboardingEmbed(title) {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.BRAND)
    .setAuthor({ name: "BAINSA · Membership application" })
    .setTitle(title);
}

function memberTypeLabel(memberType) {
  return memberType === MEMBER_TYPES.ALUMNI ? "🎓 Alumni" : "🔬 Researcher";
}

function cancelButton(requestId) {
  return new ButtonBuilder()
    .setCustomId(onboardingId(ONBOARDING_ACTIONS.CANCEL, requestId))
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);
}

function footerButtons(requestId, primary, back) {
  const primaryButton = new ButtonBuilder()
    .setCustomId(onboardingId(primary.action, requestId))
    .setLabel(primary.label)
    .setStyle(primary.style ?? ButtonStyle.Primary)
    .setDisabled(Boolean(primary.disabled));
  if (primary.emoji) primaryButton.setEmoji(primary.emoji);
  return [
    primaryButton,
    new ButtonBuilder()
      .setCustomId(onboardingId(back.action, requestId))
      .setLabel(back.label)
      .setStyle(ButtonStyle.Secondary),
    cancelButton(requestId),
  ];
}

function footerRow(requestId, primary, back) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...footerButtons(requestId, primary, back));
}

function startApplicationRow(label) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:start")
      .setLabel(label)
      .setStyle(ButtonStyle.Primary),
  );
}

function applicationDetails(request, university, divisions) {
  const divisionNames = divisions.length > 0
    ? divisions.map((division) => divisionLabel(division.name, division.color)).join(", ")
    : request.member_type === MEMBER_TYPES.ALUMNI
      ? "Not required for Alumni"
      : "Not recorded";
  return [
    { name: "Applicant", value: escapeMarkdown(request.full_name || "Not provided"), inline: true },
    { name: "Path", value: memberTypeLabel(request.member_type), inline: true },
    { name: "University", value: escapeMarkdown(university?.name || request.university_name || "Not selected"), inline: true },
    { name: "Division", value: escapeMarkdown(divisionNames), inline: true },
  ];
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
