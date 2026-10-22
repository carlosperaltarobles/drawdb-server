import type { Request, Response } from 'express';
import { config } from '../config';
import { emailStyles } from '../styles/email-styles';
import type { Mailer } from '../mail/mailer';

export function createSendHandler(mailer: Mailer) {
  return async function send(req: Request, res: Response) {
    const { subject, message } = req.body ?? {};

    if (!subject || !message) {
      res.status(400).json({ success: false, message: 'Incorrect body' });
      return;
    }

    try {
      await mailer.send({
        to: config.mail.username,
        subject,
        html: `<html><head>${emailStyles}</head><body>${message}</body></html>`,
        text: String(message).replace(/<[^>]*>/g, ''),
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
