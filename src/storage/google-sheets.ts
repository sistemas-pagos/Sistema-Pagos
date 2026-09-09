import { google, type sheets_v4 } from 'googleapis';
import { requireProductionEnv } from '@/src/config/env';
import { samePhone } from '@/src/domain/phone';
import type { HomeRecord, PaymentRecord, PendingConversation, ProcessedMessage } from '@/src/domain/types';
import {
  HOME_HEADERS,
  MESSAGE_HEADERS,
  PAYMENT_HEADERS,
  PENDING_HEADERS,
  SHEETS,
  homeFromRow,
  homeToRow,
  messageFromRow,
  messageToRow,
  paymentFromRow,
  paymentToRow,
  pendingFromRow,
  pendingToRow,
} from './sheets-schema';
import type { PaymentStore } from './types';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function safeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export class GoogleSheetsPaymentStore implements PaymentStore {
  private readonly spreadsheetId: string;
  private readonly sheets: sheets_v4.Sheets;

  constructor() {
    const config = requireProductionEnv('GOOGLE_SHEET_ID', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY');
    const auth = new google.auth.JWT({
      email: config.GOOGLE_CLIENT_EMAIL,
      key: config.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: SCOPES,
    });
    this.spreadsheetId = config.GOOGLE_SHEET_ID;
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  private async read(sheet: string, range: string): Promise<unknown[][]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${safeSheetName(sheet)}!${range}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (response.data.values ?? []) as unknown[][];
  }

  private async append(sheet: string, values: unknown[]): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${safeSheetName(sheet)}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  }

  private async replaceRow(sheet: string, rowNumber: number, values: unknown[]): Promise<void> {
    const lastColumn = columnName(values.length);
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${safeSheetName(sheet)}!A${rowNumber}:${lastColumn}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  private async clearRow(sheet: string, rowNumber: number, width: number): Promise<void> {
    const lastColumn = columnName(width);
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${safeSheetName(sheet)}!A${rowNumber}:${lastColumn}${rowNumber}`,
      requestBody: {},
    });
  }

  async ensureSchema(): Promise<void> {
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties.title',
    });
    const existing = new Set(metadata.data.sheets?.map((sheet) => sheet.properties?.title).filter(Boolean) as string[] | undefined);
    const required = [SHEETS.payments, SHEETS.homes, SHEETS.pending, SHEETS.messages, SHEETS.reconciliation, SHEETS.config];
    const missing = required.filter((title) => !existing.has(title));

    if (missing.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
      });
    }

    await Promise.all([
      this.ensureHeader(SHEETS.payments, PAYMENT_HEADERS),
      this.ensureHeader(SHEETS.homes, HOME_HEADERS),
      this.ensureHeader(SHEETS.pending, PENDING_HEADERS),
      this.ensureHeader(SHEETS.messages, MESSAGE_HEADERS),
    ]);
  }

  private async ensureHeader(sheet: string, headers: readonly string[]): Promise<void> {
    const current = await this.read(sheet, `A1:${columnName(headers.length)}1`);
    const first = current[0]?.map(String) ?? [];
    if (headers.every((header, index) => first[index] === header)) return;
    if (first.some(Boolean)) throw new Error(`Unexpected header in sheet ${sheet}; refusing to overwrite data.`);
    await this.replaceRow(sheet, 1, [...headers]);
  }

  async listPayments(): Promise<PaymentRecord[]> {
    return (await this.read(SHEETS.payments, `A2:${columnName(PAYMENT_HEADERS.length)}`))
      .map(paymentFromRow)
      .filter((row): row is PaymentRecord => Boolean(row));
  }

  async getPayment(id: string): Promise<PaymentRecord | undefined> {
    return (await this.listPayments()).find((payment) => payment.id === id);
  }

  async savePayment(payment: PaymentRecord): Promise<void> {
    if (await this.getPayment(payment.id)) throw new Error('payment_already_exists');
    await this.append(SHEETS.payments, paymentToRow(payment));
  }

  async updatePayment(payment: PaymentRecord): Promise<void> {
    const rows = await this.read(SHEETS.payments, `A2:${columnName(PAYMENT_HEADERS.length)}`);
    const index = rows.findIndex((row) => String(row[0] ?? '') === payment.id);
    if (index < 0) throw new Error('payment_not_found');
    await this.replaceRow(SHEETS.payments, index + 2, paymentToRow(payment));
  }

  async listHomes(): Promise<HomeRecord[]> {
    return (await this.read(SHEETS.homes, `A2:${columnName(HOME_HEADERS.length)}`))
      .map(homeFromRow)
      .filter((row): row is HomeRecord => Boolean(row));
  }

  async saveHome(home: HomeRecord): Promise<void> {
    const homes = await this.listHomes();
    if (homes.some((item) => item.id === home.id)) throw new Error('home_already_exists');
    if (homes.some((item) => item.stage === home.stage && item.block === home.block && item.house === home.house)) throw new Error('home_address_already_exists');
    await this.append(SHEETS.homes, homeToRow(home));
  }

  async updateHome(home: HomeRecord): Promise<void> {
    const rows = await this.read(SHEETS.homes, `A2:${columnName(HOME_HEADERS.length)}`);
    const parsed = rows.map(homeFromRow);
    const index = parsed.findIndex((item) => item?.id === home.id);
    if (index < 0) throw new Error('home_not_found');
    if (parsed.some((item) => item && item.id !== home.id && item.stage === home.stage && item.block === home.block && item.house === home.house)) {
      throw new Error('home_address_already_exists');
    }
    await this.replaceRow(SHEETS.homes, index + 2, homeToRow(home));
  }

  async getPendingByPhone(phone: string): Promise<PendingConversation | undefined> {
    const rows = await this.read(SHEETS.pending, `A2:${columnName(PENDING_HEADERS.length)}`);
    const matches = rows
      .map((row, index) => ({ row: pendingFromRow(row), rowNumber: index + 2 }))
      .filter((item): item is { row: PendingConversation; rowNumber: number } => Boolean(item.row))
      .filter((item) => samePhone(item.row.phone, phone))
      .sort((a, b) => Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt));
    const current = matches[0];
    if (!current) return undefined;
    if (Date.parse(current.row.expiresAt) <= Date.now()) {
      await this.clearRow(SHEETS.pending, current.rowNumber, PENDING_HEADERS.length);
      return undefined;
    }
    return current.row;
  }

  async savePending(pending: PendingConversation): Promise<void> {
    const rows = await this.read(SHEETS.pending, `A2:${columnName(PENDING_HEADERS.length)}`);
    const index = rows.findIndex((row) => samePhone(String(row[1] ?? ''), pending.phone));
    if (index >= 0) {
      const current = pendingFromRow(rows[index]);
      if (current && Date.parse(current.expiresAt) > Date.now() && current.paymentId !== pending.paymentId) {
        throw new Error('pending_context_conflict');
      }
      await this.replaceRow(SHEETS.pending, index + 2, pendingToRow(pending));
      return;
    }
    await this.append(SHEETS.pending, pendingToRow(pending));
  }

  async clearPending(phone: string): Promise<void> {
    const rows = await this.read(SHEETS.pending, `A2:${columnName(PENDING_HEADERS.length)}`);
    await Promise.all(
      rows.flatMap((row, index) => samePhone(String(row[1] ?? ''), phone) ? [this.clearRow(SHEETS.pending, index + 2, PENDING_HEADERS.length)] : []),
    );
  }

  async hasProcessedMessage(messageId: string): Promise<boolean> {
    return (await this.read(SHEETS.messages, `A2:${columnName(MESSAGE_HEADERS.length)}`))
      .map(messageFromRow)
      .some((message) => message?.messageId === messageId);
  }

  async saveProcessedMessage(message: ProcessedMessage): Promise<void> {
    if (await this.hasProcessedMessage(message.messageId)) return;
    await this.append(SHEETS.messages, messageToRow(message));
  }
}

function columnName(count: number): string {
  let value = count;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || 'A';
}
