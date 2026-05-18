import Contractor from '../models/Contractor.js';
import Site from '../models/Site.js';
import TradePro from '../models/TradePro.js';
import { uploadPhoto } from '../utils/cloudinary.js';
import { geocodeAddress } from '../utils/geocode.js';

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

    // Geocode address → GeoJSON coordinates (best-effort; falls back to [0,0])
    const coords = await geocodeAddress(address);
    const location = {
      type: 'Point',
      coordinates: coords ? [coords.lng, coords.lat] : [0, 0],
    };

    // Create the site document
    const site = await Site.create({
      contractor: req.userId,
      name, type, address,
      tradesNeeded: tradesArr,
      notes: notes || '',
      photo,
      location,
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

// GET /api/contractor/sites/:id/find-trades?trade=Plumber&distance=25&unit=mi
// Uses MongoDB $geoNear to find nearby trade professionals of the requested type
export async function findTrades(req, res, next) {
  console.log(`[findTrades] HIT  siteId=${req.params.id}  query=${JSON.stringify(req.query)}`);
  try {
    const site = await Site.findOne({ _id: req.params.id, contractor: req.userId });
    if (!site) {
      console.log('[findTrades] Site not found or not owned by this contractor');
      return res.status(404).json({ message: 'Site not found' });
    }

    const { trade, distance = '25', unit = 'mi' } = req.query;
    if (!trade) return res.status(400).json({ message: 'trade query param is required' });

    let [lng, lat] = site.location.coordinates;

    // Site was created before geocoding was added — geocode now and persist
    if (lng === 0 && lat === 0) {
      const coords = await geocodeAddress(site.address);
      if (!coords) {
        return res.status(422).json({ message: 'Site location could not be determined from its address.' });
      }
      lng = coords.lng;
      lat = coords.lat;
      await Site.findByIdAndUpdate(site._id, {
        location: { type: 'Point', coordinates: [lng, lat] },
      });
    }

    const meters = unit === 'km'
      ? parseFloat(distance) * 1000
      : parseFloat(distance) * 1609.344;

    const radiusKm = (meters / 1000).toFixed(1);
    const radiusMi = (meters / 1609.344).toFixed(1);
    console.log(
      `\n[findTrades] Site: "${site.name}" (${site.address})\n` +
      `             Location : lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}\n` +
      `             Trade    : ${trade}\n` +
      `             Radius   : ${radiusMi} mi / ${radiusKm} km (${Math.round(meters)} m)`
    );

    const results = await TradePro.aggregate([
      {
        $geoNear: {
          near:          { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distance',   // metres from site
          maxDistance:   meters,
          query:         { professionality: trade },
          spherical:     true,
        },
      },
      {
        $project: {
          fullName:        1,
          phone:           1,
          address:         1,
          professionality: 1,
          photo:           1,
          busyDays:        1,
          distance:        1,
          location:        1,
        },
      },
      { $limit: 50 },
    ]);

    if (results.length === 0) {
      console.log(`[findTrades] No ${trade} professionals found within radius.`);
    } else {
      console.log(`[findTrades] Found ${results.length} result(s):`);
      results.forEach((pro, i) => {
        const [proLng, proLat] = pro.location?.coordinates ?? [0, 0];
        const distKm = (pro.distance / 1000).toFixed(2);
        const distMi = (pro.distance / 1609.344).toFixed(2);
        console.log(
          `  ${i + 1}. ${pro.fullName} | lat=${proLat.toFixed(6)}, lng=${proLng.toFixed(6)} | ` +
          `${distMi} mi / ${distKm} km from site`
        );
      });
    }
    console.log('');

    // Strip location from response (internal use only)
    const sanitised = results.map(({ location: _loc, ...rest }) => rest);
    res.json({ results: sanitised, total: sanitised.length });
  } catch (err) {
    next(err);
  }
}
