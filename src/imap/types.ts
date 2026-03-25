export interface EmailSummary {
  uid: number;
  from_address: string;
  from_name: string;
  subject: string;
  date: string;
  flags: string[];
  labels: string[];
}

export interface EmailDetail extends EmailSummary {
  to: string;
  body_plain?: string;
}

export interface ActionResult {
  uid: number;
  action: string;
  operations_performed: string[];
  success: boolean;
  error?: string;
}

export interface FolderCheckResult {
  checked: string[];
  created: string[];
  already_existed: string[];
}

export interface MailboxCounts {
  inbox_total: number;
  inbox_unprocessed: number;
  folder_counts: Record<string, number>;
}
