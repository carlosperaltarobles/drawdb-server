import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { emailStyles } from '../styles/email-styles';
import type { Mailer } from '../mail/mailer';
import { parse } from '../http/validate';

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENTS_BYTES = 5 * 1024 * 1024;

/**
 * Only inline content: nodemailer would otherwise read `path`/`href` from the server's disk or
 * network, or send `raw` as is, so any other key is rejected.
 */
const attachment = z
  .strictObject({
    filename: z.string().min(1).max(255),
    content: z.string(),
    contentType: z.string().max(255).optional(),
    encoding: z.literal('base64').optional(),
  })
  .refine(
    (file) =>
      file.encoding !== 'base64' ||
      Buffer.from(file.content, 'base64').toString('base64') === file.content,
  );

function attachmentBytes(file: z.infer<typeof attachment>): number {
  return Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
}

const sendEmailSchema = z.object({
  subject: z.string().trim().min(1).max(255),
  message: z.string().min(1),
  attachments: z
    .array(attachment)
    .max(MAX_ATTACHMENTS)
    .refine(
      (list) =>
        list.reduce((bytes, file) => bytes + attachmentBytes(file), 0) <= MAX_ATTACHMENTS_BYTES,
    )
    .optional(),
});

export function createSendHandler(mailer: Mailer) {
  return async function send(req: Request, res: Response) {
    const { subject, message, attachments } = parse(sendEmailSchema, req.body);

    try {
      await mailer.send({
        to: config.mail.username,
        subject,
        html: `<html><head>${emailStyles}</head><body>${message}</body></html>`,
        text: message.replace(/<[^>]*>/g, ''),
        attachments,
      });
      res.status(200).json({
        success: true,
        message: 'Email successfully sent!',
      });
    } catch (err) {
      console.error('Email sending failed:', err);
      res.status(500).json({ success: false, message: 'Something went wrong.' });
    }
  };
}
