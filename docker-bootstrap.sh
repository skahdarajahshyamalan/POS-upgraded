#!/bin/sh

echo "Initializing Laravel configuration..."
if [ ! -f .env ]; then
    echo "Copying .env.example to .env..."
    cp .env.example .env
    
    echo "Updating database settings in .env..."
    # Update DB configurations to match docker-compose database service
    sed -i 's/DB_HOST=127.0.0.1/DB_HOST=db/g' .env
    sed -i 's/DB_DATABASE=homestead/DB_DATABASE=ultimate_pos/g' .env
    sed -i 's/DB_USERNAME=homestead/DB_USERNAME=pos_user/g' .env
    sed -i 's/DB_PASSWORD=secret/DB_PASSWORD=pos_password/g' .env
fi

echo "Running Composer Install..."
composer install --no-interaction --optimize-autoloader

echo "Generating Application Key..."
php artisan key:generate

echo "Running Database Migrations..."
php artisan migrate --force

echo "Setting storage permissions..."
chmod -R 775 storage bootstrap/cache

echo "Docker Bootstrap complete!"
