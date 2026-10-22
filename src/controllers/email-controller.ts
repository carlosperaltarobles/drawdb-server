import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { emailStyles } from '../styles/email-styles';
import type { Mailer } from '../mail/mailer';
import { parse } from '../http/validate';

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENTS_CHARS = 5 * 1024 * 1024;

/**
 * Only inline content: nodemailer would otherwise read `path`/`href` from the server's disk or
 * network, or send `raw` as is, so any other key is rejected.
 */
const attachment = z.strictObject({
  filename: z.string().min(1).max(255),
  content: z.string(),
  contentType: z.string().max(255).optional(),
  encoding: z.literal('base64').optional(),
});

const sendEmailSchema = z.object({
  subject: z.string().trim().min(1).max(255),
  message: z.string().min(1),
  attachments: z
    .array(attachment)
    .max(MAX_ATTACHMENTS)
    .refine(
      (list) => list.reduce((chars, a) => chars + a.content.length, 0) <= MAX_ATTACHMENTS_CHARS,
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
        message: `Email sent to ${config.mail.username}`,
      });
    } catch (err) {
      console.error('Email sending failed:', err);
      res.status(500).json({ success: false, message: 'Something went wrong.' });
    }
  };
}
