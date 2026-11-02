/** Preserve installed historical records. Fresh setup never declares these definitions. */
import type { SchemaDefinition } from "./schemas.ts";

export const HISTORICAL_SCHEMAS: Array<{
  key: string;
  schema: SchemaDefinition;
}> = [
  {
    key: "board_cards",
    schema: {
      name: "BoardCards",
      owner_app_id: "fkanban",
      descriptive_name: "BoardCards_hashrange_v1",
      purpose_statement:
        "Thin per-board card membership (HashRange) so list/pickup never full-scan Card or hydrate bodies",
      schema_type: "HashRange",
      key: {
        hash_field: "board",
        range_field: "sk",
      },
      fields: [
        "board",
        "sk",
        "slug",
        "title",
        "column",
        "position",
        "assignee",
        "tags",
        "deps",
        "surfaces",
        "created_at",
        "created_by",
        "updated_at",
        "db",
        "repo",
        "base",
        "kind",
        "block_status",
        "block_reason",
        "north_star",
        "milestone",
        "pr_url",
        "branch",
        "layout",
      ],
      field_types: {
        board: "String",
        sk: "String",
        slug: "String",
        title: "String",
        column: "String",
        position: "String",
        assignee: "String",
        tags: {
          Array: "String",
        },
        deps: {
          Array: "String",
        },
        surfaces: {
          Array: "String",
        },
        created_at: "String",
        created_by: "String",
        updated_at: "String",
        db: "String",
        repo: "String",
        base: "String",
        kind: "String",
        block_status: "String",
        block_reason: "String",
        north_star: "String",
        milestone: "String",
        pr_url: "String",
        branch: "String",
        layout: "String",
      },
      field_descriptions: {
        board: "board slug",
        sk: "sort key column#position(8)#slug",
        slug: "card slug",
        title: "one-line card name",
        column: "backlog|todo|doing|done",
        position: "integer-as-string ordering within the column",
        assignee: "who owns the card",
        tags: "array of freeform labels",
        deps: "array of dependency card slugs",
        surfaces: "array of path globs / subsystem names",
        created_at: "RFC 3339 timestamp",
        created_by: "creator identity",
        updated_at: "RFC 3339 timestamp",
        db: "home LastDB locator",
        repo: "owner/name of the code repo",
        base: "PR base branch",
        kind: "pr|registry|tracker|...",
        block_status: "none|needs_human|design_first|deferred",
        block_reason: "free-text when blocked",
        north_star: "North Star slug",
        milestone: "Milestone slug",
        pr_url: "PR URL when in flight",
        branch: "feature branch",
        layout:
          "identity marker for HashRange board membership partition (do not change without new schema)",
      },
      field_classifications: {
        title: ["word"],
      },
      field_data_classifications: {
        board: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        sk: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        slug: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        title: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        column: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        position: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        assignee: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        tags: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        deps: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        surfaces: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        created_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        created_by: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        updated_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        db: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        repo: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        base: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        kind: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        block_status: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        block_reason: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        north_star: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        milestone: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        pr_url: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        branch: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        layout: {
          sensitivity_level: 0,
          data_domain: "general",
        },
      },
    },
  },
  {
    key: "milestone_cards",
    schema: {
      name: "MilestoneCards",
      owner_app_id: "fkanban",
      descriptive_name: "MilestoneCards_hashrange_v1_children_20260723",
      purpose_statement:
        "Thin per-milestone card membership (HashRange) so detail/reconcile never filter all board cards",
      schema_type: "HashRange",
      key: {
        hash_field: "milestone",
        range_field: "sk",
      },
      fields: [
        "milestone",
        "sk",
        "slug",
        "title",
        "board",
        "column",
        "position",
        "assignee",
        "tags",
        "deps",
        "surfaces",
        "created_at",
        "created_by",
        "updated_at",
        "db",
        "repo",
        "base",
        "kind",
        "block_status",
        "block_reason",
        "north_star",
        "pr_url",
        "branch",
        "layout",
      ],
      field_types: {
        milestone: "String",
        sk: "String",
        slug: "String",
        title: "String",
        board: "String",
        column: "String",
        position: "String",
        assignee: "String",
        tags: {
          Array: "String",
        },
        deps: {
          Array: "String",
        },
        surfaces: {
          Array: "String",
        },
        created_at: "String",
        created_by: "String",
        updated_at: "String",
        db: "String",
        repo: "String",
        base: "String",
        kind: "String",
        block_status: "String",
        block_reason: "String",
        north_star: "String",
        pr_url: "String",
        branch: "String",
        layout: "String",
      },
      field_descriptions: {
        board: "board slug",
        sk: "sort key column#position(8)#slug",
        slug: "card slug",
        title: "one-line card name",
        column: "backlog|todo|doing|done",
        position: "integer-as-string ordering within the column",
        assignee: "who owns the card",
        tags: "array of freeform labels",
        deps: "array of dependency card slugs",
        surfaces: "array of path globs / subsystem names",
        created_at: "RFC 3339 timestamp",
        created_by: "creator identity",
        updated_at: "RFC 3339 timestamp",
        db: "home LastDB locator",
        repo: "owner/name of the code repo",
        base: "PR base branch",
        kind: "pr|registry|tracker|...",
        block_status: "none|needs_human|design_first|deferred",
        block_reason: "free-text when blocked",
        north_star: "North Star slug",
        milestone: "Milestone slug",
        pr_url: "PR URL when in flight",
        branch: "feature branch",
        layout:
          "identity marker for HashRange milestone membership partition (do not change without new schema)",
      },
      field_classifications: {
        title: ["word"],
      },
      field_data_classifications: {
        milestone: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        sk: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        slug: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        title: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        board: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        column: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        position: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        assignee: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        tags: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        deps: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        surfaces: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        created_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        created_by: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        updated_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        db: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        repo: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        base: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        kind: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        block_status: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        block_reason: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        north_star: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        pr_url: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        branch: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        layout: {
          sensitivity_level: 0,
          data_domain: "general",
        },
      },
    },
  },
  {
    key: "board_milestones",
    schema: {
      name: "BoardMilestones",
      owner_app_id: "fkanban",
      descriptive_name: "FkanbanMilestonePortfolioByBoardIndex",
      purpose_statement:
        "Per-board index of milestone outcomes and their proof/completion lifecycle; partitioned by board so the milestone portfolio and gap report load without a full Milestone scan",
      schema_type: "HashRange",
      key: {
        hash_field: "board",
        range_field: "sk",
      },
      fields: [
        "board",
        "sk",
        "slug",
        "title",
        "body",
        "state",
        "position",
        "north_star",
        "driver",
        "deps",
        "proof_card",
        "proof_status",
        "block_reason",
        "created_at",
        "updated_at",
        "completed_at",
        "layout",
      ],
      field_types: {
        board: "String",
        sk: "String",
        slug: "String",
        title: "String",
        body: "String",
        state: "String",
        position: "String",
        north_star: "String",
        driver: "String",
        deps: {
          Array: "String",
        },
        proof_card: "String",
        proof_status: "String",
        block_reason: "String",
        created_at: "String",
        updated_at: "String",
        completed_at: "String",
        layout: "String",
      },
      field_descriptions: {
        slug: "milestone slug",
        title: "one-line outcome name",
        body: "markdown outcome, acceptance criteria, and rationale",
        board: "board whose cards this milestone groups",
        state: "planned|active|blocked|proving|complete|abandoned",
        position: "integer-as-string portfolio ordering",
        north_star: "fbrain North Star slug this outcome advances",
        driver: "person, agent, or routine responsible for reconciliation",
        deps: "array of milestone slugs that must complete first",
        proof_card: "terminal validation card slug",
        proof_status: "pending|passing|failing|not_required",
        block_reason: "why the milestone is blocked",
        created_at: "RFC 3339 timestamp",
        updated_at: "RFC 3339 timestamp",
        completed_at: "RFC 3339 completion timestamp, empty until complete",
        sk: "sort key state#position(8)#slug for ordered portfolio lists",
        layout: "identity marker for HashRange layout",
      },
      field_classifications: {
        title: ["word"],
        body: ["word"],
      },
      field_data_classifications: {
        board: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        sk: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        slug: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        title: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        body: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        state: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        position: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        north_star: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        driver: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        deps: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        proof_card: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        proof_status: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        block_reason: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        created_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        updated_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        completed_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        layout: {
          sensitivity_level: 0,
          data_domain: "general",
        },
      },
    },
  },
  {
    key: "card_list_index",
    schema: {
      name: "CardListIndex",
      owner_app_id: "fkanban",
      descriptive_name: "CardListIndex",
      purpose_statement:
        "Single-row body-free index of every live card so list/pickup never full-scan Card",
      schema_type: "Hash",
      key: {
        hash_field: "key",
      },
      fields: ["key", "payload_json", "updated_at"],
      field_types: {
        key: "String",
        payload_json: "String",
        updated_at: "String",
      },
      field_descriptions: {
        key: "index row id (always all_cards)",
        payload_json: "JSON array of body-free card summaries",
        updated_at: "RFC 3339 timestamp",
      },
      field_classifications: {},
      field_data_classifications: {
        key: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        payload_json: {
          sensitivity_level: 0,
          data_domain: "general",
        },
        updated_at: {
          sensitivity_level: 0,
          data_domain: "general",
        },
      },
    },
  },
];
