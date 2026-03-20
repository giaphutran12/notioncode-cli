import { Client } from "@notionhq/client";

const MAX_RICH_TEXT_LENGTH = 2000;
const STATUS_PROPERTY_NAME = "Status";
let notionClient: Client | null = null;

export interface TicketSummary {
  id: string;
  title: string;
  description: string;
  status: string | null;
}

export type Ticket = TicketSummary & Record<string, unknown>;

type NotionProperty = {
  type: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  number?: number | null;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  checkbox?: boolean;
};

type NotionPage = {
  id: string;
  properties: Record<string, NotionProperty>;
};

type StatusProperty = {
  name: string;
  type: "status" | "select";
};

type DataSourcePropertyMap = Record<string, { type: string }>;

function getDatabaseDataSourceId(
  database: Awaited<ReturnType<Client["databases"]["retrieve"]>>
): string {
  if ("data_sources" in database && database.data_sources.length > 0) {
    return database.data_sources[0].id;
  }

  return database.id;
}

function getNotionToken(): string {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error("NOTION_TOKEN is required to use src/notion.ts");
  }

  return token;
}

function getNotionDatabaseId(): string {
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!databaseId) {
    throw new Error("NOTION_DATABASE_ID is required to use src/notion.ts");
  }

  return databaseId;
}

function getNotionClient(): Client {
  if (!notionClient) {
    notionClient = new Client({ auth: getNotionToken() });
  }

  return notionClient;
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isRateLimited(error)) {
      await sleep(1000);
      return await operation();
    }

    throw error;
  }
}

function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { status?: number; code?: string };
  return candidate.status === 429 || candidate.code === "rate_limited";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capRichText(text: string): string {
  if (text.length <= MAX_RICH_TEXT_LENGTH) {
    return text;
  }

  return `...${text.slice(-(MAX_RICH_TEXT_LENGTH - 3))}`;
}

function toRichText(text: string) {
  return [
    {
      type: "text" as const,
      text: {
        content: capRichText(text),
      },
    },
  ];
}

function flattenProperties(page: NotionPage): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(page.properties)) {
    switch (value.type) {
      case "title":
        flattened[key] = value.title?.[0]?.plain_text ?? "";
        break;
      case "rich_text":
        flattened[key] = value.rich_text?.[0]?.plain_text ?? "";
        break;
      case "number":
        flattened[key] = value.number ?? null;
        break;
      case "select":
        flattened[key] = value.select?.name ?? null;
        break;
      case "status":
        flattened[key] = value.status?.name ?? null;
        break;
      case "checkbox":
        flattened[key] = Boolean(value.checkbox);
        break;
      default:
        break;
    }
  }

  return flattened;
}

function getStatus(page: NotionPage): string | null {
  const props = page.properties;

  if (STATUS_PROPERTY_NAME in props) {
    const statusProp = props[STATUS_PROPERTY_NAME];

    if (statusProp.type === "status") {
      return statusProp.status?.name ?? null;
    }

    if (statusProp.type === "select") {
      return statusProp.select?.name ?? null;
    }
  }

  for (const prop of Object.values(props)) {
    if (prop.type === "status") {
      return prop.status?.name ?? null;
    }

    if (prop.type === "select") {
      return prop.select?.name ?? null;
    }
  }

  return null;
}

function getTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      return prop.title?.[0]?.plain_text ?? "";
    }
  }

  return "";
}

function getDescription(page: NotionPage): string {
  const props = page.properties;
  const preferred = props.Description ?? props.description;

  if (preferred?.type === "rich_text") {
    return preferred.rich_text?.[0]?.plain_text ?? "";
  }

  for (const prop of Object.values(props)) {
    if (prop.type === "rich_text") {
      return prop.rich_text?.[0]?.plain_text ?? "";
    }
  }

  return "";
}

function findStatusProperty(page: NotionPage): StatusProperty {
  const props = page.properties;

  if (STATUS_PROPERTY_NAME in props) {
    const statusProp = props[STATUS_PROPERTY_NAME];

    if (statusProp.type === "status" || statusProp.type === "select") {
      return { name: STATUS_PROPERTY_NAME, type: statusProp.type };
    }
  }

  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "status" || prop.type === "select") {
      return { name, type: prop.type };
    }
  }

  throw new Error("Could not find a status/select property on the page");
}

async function getDatabaseStatusProperty(): Promise<StatusProperty> {
  const notion = getNotionClient();
  const databaseId = getNotionDatabaseId();
  const database = await withRetry(() =>
    notion.databases.retrieve({ database_id: databaseId })
  );

  const dataSourceId = getDatabaseDataSourceId(database);

  const dataSource = await withRetry(() =>
    notion.dataSources.retrieve({ data_source_id: dataSourceId })
  );
  const properties = dataSource.properties as DataSourcePropertyMap;

  if (STATUS_PROPERTY_NAME in properties) {
    const prop = properties[STATUS_PROPERTY_NAME];

    if (prop.type === "status" || prop.type === "select") {
      return { name: STATUS_PROPERTY_NAME, type: prop.type };
    }
  }

  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === "status" || prop.type === "select") {
      return { name, type: prop.type };
    }
  }

  throw new Error("Could not find a status/select property on the database");
}

function toTicket(page: NotionPage): Ticket {
  const flattened = flattenProperties(page);

  return {
    ...flattened,
    id: page.id,
    title: getTitle(page),
    description: getDescription(page),
    status: getStatus(page),
  };
}

export async function listTickets(status?: string): Promise<TicketSummary[]> {
  const notion = getNotionClient();
  const databaseId = getNotionDatabaseId();
  const database = await withRetry(() =>
    notion.databases.retrieve({ database_id: databaseId })
  );
  const dataSourceId = getDatabaseDataSourceId(database);

  const statusProperty = status ? await getDatabaseStatusProperty() : null;

  const filter = statusProperty && status
    ? statusProperty.type === "status"
      ? {
          property: statusProperty.name,
          status: {
            equals: status,
          },
        }
      : {
          property: statusProperty.name,
          select: {
            equals: status,
          },
        }
    : undefined;

  const response = (await withRetry(() =>
    notion.dataSources.query({
      data_source_id: dataSourceId,
      filter,
    })
  )) as { results: NotionPage[] };

  return response.results.map((page) => ({
    id: page.id,
    title: getTitle(page),
    description: getDescription(page),
    status: getStatus(page),
  }));
}

export async function getTicket(pageId: string): Promise<Ticket> {
  const page = (await withRetry(() =>
    getNotionClient().pages.retrieve({ page_id: pageId })
  )) as NotionPage;

  return toTicket(page);
}

export async function updateStatus(pageId: string, status: string): Promise<void> {
  const notion = getNotionClient();
  const page = (await withRetry(() =>
    notion.pages.retrieve({ page_id: pageId })
  )) as NotionPage;
  const { name, type } = findStatusProperty(page);

  await withRetry(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        [name]:
          type === "status"
            ? {
                status: {
                  name: status,
                },
              }
            : {
                select: {
                  name: status,
                },
              },
      },
    })
  );
}

export async function postComment(pageId: string, text: string): Promise<void> {
  await withRetry(() =>
    getNotionClient().comments.create({
      parent: { page_id: pageId },
      rich_text: toRichText(text),
    })
  );
}

export async function updateProperty(
  pageId: string,
  propName: string,
  value: string
): Promise<void> {
  await withRetry(() =>
    getNotionClient().pages.update({
      page_id: pageId,
      properties: {
        [propName]: {
          rich_text: toRichText(value),
        },
      },
    })
  );
}
