const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const productController = require('../controllers/productController');
const router = express.Router();

const uploadDirectory = path.join(__dirname, '..', '..', 'public', 'uploads', 'products');
const imageExtensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif'
};
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, callback) => {
            fs.mkdir(uploadDirectory, { recursive: true })
                .then(() => callback(null, uploadDirectory))
                .catch(callback);
        },
        filename: (req, file, callback) => {
            callback(null, `${crypto.randomUUID()}${imageExtensions[file.mimetype]}`);
        }
    }),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 6
    },
    fileFilter: (req, file, callback) => {
        if (!imageExtensions[file.mimetype]){
            return callback(new Error('Upload JPEG, PNG, WebP, or AVIF images only.'));
        }
        return callback(null, true);
    }
});

function handleProductUpload(req, res, next){
    upload.array('images', 6)(req, res, (error) => {
        if (!error){
            return next();
        }
        let message = error.message;
        if (error instanceof multer.MulterError){
            if (error.code === 'LIMIT_FILE_SIZE'){
                message = 'Each image must be 5 MB or smaller.';
            } else if (error.code === 'LIMIT_UNEXPECTED_FILE'){
                message = 'Upload no more than six product images.';
            }
        }
        return res.status(400).json({ error: message });
    });
}

router.post('/products', handleProductUpload, productController.createProduct);
router.put('/products/:id', handleProductUpload, productController.updateProduct);
router.delete('/products/:id', productController.deleteProduct);

module.exports = router;
