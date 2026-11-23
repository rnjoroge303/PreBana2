require('dotenv').config()
const express = require('express');
const port = Number(process.env.PORT) || 8080


const path = require('path')
const mpath = path.join(__dirname, 'src','routes','mainRoutes')
const app = express()
const authController = require(path.join(__dirname, 'src', 'controllers', 'authController'))
const { handleMpesaCallback } = require(path.join(__dirname, 'src', 'controllers', 'callbackurl'))
const mainRoutes = require(mpath)

const views = [
    path.join(__dirname, 'src', 'views'),
    path.join(__dirname, 'src', 'views', 'client'),
    path.join(__dirname, 'src', 'views', 'client', 'includes'),
    path.join(__dirname, 'src', 'views','admin'),
    path.join(__dirname, 'src', 'views','admin', 'includes'),
]

app.set('view engine', 'ejs')
app.set('views', views)
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json({ limit: '64kb' }))
app.use(express.urlencoded({ extended: true, limit: '32kb' }))
app.post('/api/mpesa/callback', handleMpesaCallback)
app.use('/pre', mainRoutes)
app.get('/', (req,res)=>{
    res.status(200).redirect('/pre/store')
})
app.use((req,res)=>{
    return res.status(404).render('404.ejs')
})

authController.initializeUserStore()
    .then(() => {
        app.listen(port, () => {
            console.log(`Server running on localhost:${port}`)
        })
    })
    .catch((error) => {
        console.error('Unable to initialize user store:', error.message)
        process.exitCode = 1
    })