import Chat from '../models/Chat.js';
import TradePro from '../models/TradePro.js';
import Site from '../models/Site.js';
import Contractor from '../models/Contractor.js';
import { uploadChatFile as cloudinaryUploadChatFile } from '../utils/cloudinary.js';
import path from 'path';

// GET /api/chat/:contractorId/:tradeProId/:siteId
// Returns (or creates) a chat thread between a contractor and trade pro for a site
export async function getOrCreateChat(req, res, next) {
  try {
    const { contractorId, tradeProId, siteId } = req.params;

    // Auth: caller must be one of the two parties
    const callerId = req.userId;
    const callerRole = req.userType; // 'contractor' | 'trade'
    if (callerRole === 'contractor' && String(contractorId) !== String(callerId))
      return res.status(403).json({ message: 'Not authorised' });
    if (callerRole === 'trade' && String(tradeProId) !== String(callerId))
      return res.status(403).json({ message: 'Not authorised' });

    let chat = await Chat.findOne({ contractorId, tradeProId, siteId }).lean();

    if (!chat) {
      // Fetch names for denormalisation
      const [pro, site] = await Promise.all([
        TradePro.findById(tradeProId).select('fullName').lean(),
        Site.findById(siteId).select('name').lean(),
      ]);
      chat = await Chat.create({
        contractorId,
        tradeProId,
        siteId,
        siteName:  site?.name  ?? '',
        tradeName: pro?.fullName ?? '',
        messages:  [],
      });
      chat = chat.toObject();
    }

    res.json({ chat });
  } catch (err) {
    next(err);
  }
}

// POST /api/chat/upload  — upload a file to Cloudinary, save message, broadcast via socket
// Expects multipart form: file + { contractorId, tradeProId, siteId, text? }
export async function uploadChatFile(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const { contractorId, tradeProId, siteId, text = '' } = req.body;
    if (!contractorId || !tradeProId || !siteId)
      return res.status(400).json({ message: 'contractorId, tradeProId and siteId are required' });

    const sender = req.userType === 'trade' ? 'trade' : 'contractor';

    // Determine file type label
    const ext = path.extname(req.file.originalname).toLowerCase();
    let fileType = 'image';
    if (ext === '.pdf') fileType = 'pdf';
    else if (['.doc', '.docx'].includes(ext)) fileType = 'word';

    // Upload to Cloudinary — extension is embedded in public_id for raw files
    // so the resulting URL ends in .docx / .pdf and browsers download correctly
    const result = await cloudinaryUploadChatFile(req.file.buffer, req.file.originalname);
    const fileUrl = result.secure_url;

    const msgData = {
      sender,
      text:          text.trim(),
      fileUrl,
      filePublicId:  result.public_id,
      fileName:      req.file.originalname,
      fileType,
      timestamp:     new Date(),
    };

    // Persist to DB
    const chat = await Chat.findOneAndUpdate(
      { contractorId, tradeProId, siteId },
      { $push: { messages: msgData } },
      { new: true, upsert: true }
    );
    const saved = chat.messages[chat.messages.length - 1];

    // Broadcast via socket.io (attached to app)
    const io = req.app.get('io');
    if (io) {
      const room = `chat:${contractorId}:${tradeProId}:${siteId}`;
      io.to(room).emit('new_message', {
        _id:          saved._id,
        sender:       saved.sender,
        text:         saved.text,
        fileUrl:      saved.fileUrl,
        fileName:     saved.fileName,
        fileType:     saved.fileType,
        timestamp:    saved.timestamp,
      });
    }

    res.json({ ok: true, message: saved });
  } catch (err) {
    next(err);
  }
}

// GET /api/chat/trade/:siteId  — trade pro side: looks up contractorId from site
export async function getTradeChat(req, res, next) {
  try {
    const { siteId } = req.params;
    const tradeProId = req.userId;

    const site = await Site.findById(siteId).select('name contractor').lean();
    if (!site) return res.status(404).json({ message: 'Site not found' });

    const contractorId = site.contractor;

    let chat = await Chat.findOne({ contractorId, tradeProId, siteId }).lean();
    if (!chat) {
      const [pro] = await Promise.all([
        TradePro.findById(tradeProId).select('fullName').lean(),
      ]);
      chat = await Chat.create({
        contractorId,
        tradeProId,
        siteId,
        siteName:  site.name ?? '',
        tradeName: pro?.fullName ?? '',
        messages:  [],
      });
      chat = chat.toObject();
    }

    res.json({ chat, contractorId: String(contractorId) });
  } catch (err) {
    next(err);
  }
}
