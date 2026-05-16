import Contractor from '../models/Contractor.js';
import Site from '../models/Site.js';
import { uploadPhoto } from '../utils/cloudinary.js';

// GET /api/contractor/me
// Returns contractor profile + count of sites
export async function getMe(req, res, next) {
  try {
    const contractor = await Contractor.findById(req.userId).populate('sites', 'name type status');
    res.json({ contractor });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/me
export async function updateMe(req, res, next) {
  try {
    const { companyName, phone, address, expertise } = req.body;
    const updates = {};
    if (companyName !== undefined) updates.companyName = companyName;
    if (phone       !== undefined) updates.phone       = phone;
    if (address     !== undefined) updates.address     = address;
    if (expertise   !== undefined) {
      updates.expertise = Array.isArray(expertise) ? expertise : JSON.parse(expertise);
    }

    const contractor = await Contractor.findByIdAndUpdate(
      req.userId,
      updates,
      { new: true, runValidators: true }
    ).populate('sites', 'name type status');

    res.json({ contractor });
  } catch (err) {
    next(err);
  }
}

// POST /api/contractor/sites
// Creates site, stores full details, and pushes ref onto contractor.sites
export async function createSite(req, res, next) {
  try {
    const { name, type, address, tradesNeeded, notes } = req.body;

    let photo;
    if (req.file) {
      const result = await uploadPhoto(req.file.buffer, 'tradelink/sites');
      photo = result.secure_url;
    }

    const tradesArr = Array.isArray(tradesNeeded)
      ? tradesNeeded
      : typeof tradesNeeded === 'string'
        ? JSON.parse(tradesNeeded)
        : [];

    // Create the site document
    const site = await Site.create({
      contractor: req.userId,
      name, type, address,
      tradesNeeded: tradesArr,
      notes: notes || '',
      photo,
    });

    // Maintain bidirectional reference on contractor
    await Contractor.findByIdAndUpdate(req.userId, { $push: { sites: site._id } });

    res.status(201).json({ site });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites
// Returns all sites for the authenticated contractor with full details
export async function getSites(req, res, next) {
  try {
    const sites = await Site.find({ contractor: req.userId }).sort({ createdAt: -1 });
    res.json({ sites });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites/:id
export async function getSite(req, res, next) {
  try {
    const site = await Site.findOne({ _id: req.params.id, contractor: req.userId });
    if (!site) return res.status(404).json({ message: 'Site not found' });
    res.json({ site });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/sites/:id
export async function updateSite(req, res, next) {
  try {
    const { name, type, address, tradesNeeded, notes, status } = req.body;
    const updates = {};
    if (name         !== undefined) updates.name   = name;
    if (type         !== undefined) updates.type   = type;
    if (address      !== undefined) updates.address = address;
    if (notes        !== undefined) updates.notes  = notes;
    if (status       !== undefined) updates.status = status;
    if (tradesNeeded !== undefined) {
      updates.tradesNeeded = Array.isArray(tradesNeeded)
        ? tradesNeeded
        : JSON.parse(tradesNeeded);
    }

    if (req.file) {
      const result = await uploadPhoto(req.file.buffer, 'tradelink/sites');
      updates.photo = result.secure_url;
    }

    const site = await Site.findOneAndUpdate(
      { _id: req.params.id, contractor: req.userId },
      updates,
      { new: true, runValidators: true }
    );
    if (!site) return res.status(404).json({ message: 'Site not found' });
    res.json({ site });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/contractor/sites/:id
export async function deleteSite(req, res, next) {
  try {
    const site = await Site.findOneAndDelete({ _id: req.params.id, contractor: req.userId });
    if (!site) return res.status(404).json({ message: 'Site not found' });

    // Remove the reference from contractor.sites
    await Contractor.findByIdAndUpdate(req.userId, { $pull: { sites: site._id } });

    res.json({ message: 'Site deleted' });
  } catch (err) {
    next(err);
  }
}
