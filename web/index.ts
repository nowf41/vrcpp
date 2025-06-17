const express = require('express');

const app = express();

// template engine
app.set('views', './views');
app.set('view engine', 'pug');
app.use(express.static('./static'));

// routes
app.use('/', require('./routes/rootRenderer'));

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server started at http://localhost:${process.env.PORT || 3000}`);
})